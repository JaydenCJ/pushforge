/**
 * The pushforge CLI. Thin by design: every command maps onto the public API
 * (keys, store, sender, queue, ece), keeps state in explicit JSON files, and
 * exits 0 on success, 1 when an operation legitimately fails (a delivery was
 * refused, a body would not decrypt) and 2 on usage or I/O errors.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64urlDecode, b64urlEncode, utf8, utf8Decode } from "./b64url.js";
import { decrypt } from "./ece.js";
import { loadJsonFile, saveJsonFile } from "./jsonfile.js";
import { generateVapidKeys } from "./keys.js";
import { createMockSubscriber, type MockSubscriberSecrets } from "./mock.js";
import { DeliveryQueue } from "./queue.js";
import { buildPushRequest, classifyStatus, fetchTransport, validateTopic, validateTtl, validateUrgency } from "./sender.js";
import { SubscriptionStore } from "./store.js";
import type { MessageOptions, VapidKeys } from "./types.js";
import { validateSubject, type VapidOptions } from "./vapid.js";
import { VERSION } from "./version.js";

const DEFAULT_STORE = "subscriptions.json";
const DEFAULT_QUEUE = "queue.json";
const DEFAULT_VAPID = "vapid.json";
const DEFAULT_UA_KEYS = "ua-keys.json";

class UsageError extends Error {}
class OperationError extends Error {}

const HELP = `pushforge ${VERSION} — self-hosted Web Push: VAPID, RFC 8291, store, queue

Usage:
  pushforge keygen   [--subject URI] [--out FILE] [--force]
  pushforge mock     [--endpoint URL] [--keys-out FILE] [--force]
  pushforge add      [FILE|-] [--store FILE] [--tag TAG]...
  pushforge list     [--store FILE] [--tag TAG] [--json]
  pushforge remove   ID|ENDPOINT [--store FILE]
  pushforge send     [MESSAGE|-] --vapid FILE [--subject URI]
                     (--to ID... | --tag TAG | --all) [--store FILE]
                     [--ttl N] [--urgency U] [--topic T]
                     [--dry-run] [--out DIR]
  pushforge enqueue  [MESSAGE|-] (--to ID... | --tag TAG | --all)
                     [--store FILE] [--queue FILE]
                     [--ttl N] [--urgency U] [--topic T] [--max-attempts N]
  pushforge drain    --vapid FILE [--subject URI] [--queue FILE] [--store FILE] [--dry-run]
  pushforge queue-status [--queue FILE] [--json] [--clear-finished]
  pushforge decrypt  FILE [--keys FILE]
  pushforge --help | --version

Files (all plain JSON, safe to inspect and back up):
  vapid.json            VAPID key pair + subject      (keygen)
  subscriptions.json    the subscriber store          (add/list/remove)
  queue.json            the delivery queue            (enqueue/drain)
  ua-keys.json          mock-subscriber private keys  (mock/decrypt)

Exit codes: 0 ok · 1 operation failed (refused delivery, bad decrypt) · 2 usage/IO error.
`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

const VALUE_FLAGS = new Set([
  "--subject", "--out", "--endpoint", "--keys-out", "--store", "--tag", "--to",
  "--ttl", "--urgency", "--topic", "--queue", "--vapid", "--keys", "--max-attempts",
]);
const BOOL_FLAGS = new Set(["--force", "--json", "--all", "--dry-run", "--clear-finished", "--help", "--version"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const push = (flag: string, value: string): void => {
    const list = flags.get(flag) ?? [];
    list.push(value);
    flags.set(flag, list);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-" || !arg.startsWith("--")) {
      positional.push(arg);
    } else if (BOOL_FLAGS.has(arg)) {
      push(arg, "true");
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      push(arg, value);
    } else {
      throw new UsageError(`unknown flag ${arg} (see pushforge --help)`);
    }
  }
  return { positional, flags };
}

function one(args: ParsedArgs, flag: string): string | undefined {
  const values = args.flags.get(flag);
  if (values && values.length > 1) throw new UsageError(`${flag} may only be given once`);
  return values?.[0];
}

function has(args: ParsedArgs, flag: string): boolean {
  return args.flags.has(flag);
}

function intFlag(args: ParsedArgs, flag: string): number | undefined {
  const raw = one(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`${flag} must be an integer, got ${JSON.stringify(raw)}`);
  return value;
}

// A closed pipe (`pushforge list | head -1`) is normal Unix usage, not a crash.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

function out(text: string): void {
  process.stdout.write(text + "\n");
}

/** "1 job", "2 jobs", "1 delivery", "3 deliveries". */
function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readTextArg(positional: string | undefined, what: string): Promise<string> {
  if (positional === undefined) throw new UsageError(`missing ${what} (pass it as an argument, or - for stdin)`);
  if (positional === "-") return (await readStdin()).replace(/\n$/, "");
  return positional;
}

function readFileOrThrow(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new UsageError(`cannot read ${path}`);
  }
}

interface VapidFile extends VapidKeys {
  subject?: string;
}

function loadVapid(args: ParsedArgs): VapidOptions {
  const path = one(args, "--vapid") ?? DEFAULT_VAPID;
  if (!existsSync(path)) {
    throw new UsageError(`VAPID key file ${path} not found — run: pushforge keygen --out ${path}`);
  }
  const data = loadJsonFile<VapidFile>(path, "vapid", { publicKey: "", privateKey: "" });
  const subject = one(args, "--subject") ?? data.subject;
  if (subject === undefined) {
    throw new UsageError(`no VAPID subject: pass --subject mailto:you@example.test or bake one in with keygen --subject`);
  }
  return { keys: { publicKey: data.publicKey, privateKey: data.privateKey }, subject: validateSubject(subject) };
}

/** Rethrow validation failures on user-provided input as usage errors. */
function usage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function usageAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function messageOptions(args: ParsedArgs): MessageOptions {
  const options: MessageOptions = {};
  const ttl = intFlag(args, "--ttl");
  if (ttl !== undefined) options.ttl = usage(() => validateTtl(ttl));
  const urgency = one(args, "--urgency");
  if (urgency !== undefined) options.urgency = usage(() => validateUrgency(urgency));
  const topic = one(args, "--topic");
  if (topic !== undefined) options.topic = usage(() => validateTopic(topic));
  return options;
}

function selectTargets(args: ParsedArgs, store: SubscriptionStore) {
  return usage(() =>
    store.select({
      ids: args.flags.get("--to"),
      tag: one(args, "--tag"),
      all: has(args, "--all"),
    }),
  );
}

function refuseOverwrite(path: string, force: boolean): void {
  if (existsSync(path) && !force) {
    throw new UsageError(`${path} already exists (pass --force to overwrite)`);
  }
}

// ---------------------------------------------------------------- commands

async function cmdKeygen(args: ParsedArgs): Promise<number> {
  const keys = await generateVapidKeys();
  const subjectFlag = one(args, "--subject");
  const data: VapidFile = subjectFlag !== undefined ? { ...keys, subject: validateSubject(subjectFlag) } : keys;
  const path = one(args, "--out");
  if (path !== undefined) {
    refuseOverwrite(path, has(args, "--force"));
    saveJsonFile(path, "vapid", data);
    out(`wrote VAPID key pair to ${path}`);
    out(`applicationServerKey (give this to the browser):`);
    out(keys.publicKey);
  } else {
    out(JSON.stringify(data, null, 2));
  }
  return 0;
}

async function cmdMock(args: ParsedArgs): Promise<number> {
  const mock = await createMockSubscriber(one(args, "--endpoint"));
  const keysPath = one(args, "--keys-out") ?? DEFAULT_UA_KEYS;
  refuseOverwrite(keysPath, has(args, "--force"));
  saveJsonFile(keysPath, "mock-subscriber", mock.secrets);
  process.stderr.write(`wrote mock subscriber private keys to ${keysPath}\n`);
  out(JSON.stringify(mock.subscription, null, 2));
  return 0;
}

async function cmdAdd(args: ParsedArgs): Promise<number> {
  const source = args.positional[1] ?? "-";
  const text = source === "-" ? await readStdin() : readFileOrThrow(source);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${source === "-" ? "stdin" : source} is not valid JSON`);
  }
  const store = SubscriptionStore.open(one(args, "--store") ?? DEFAULT_STORE);
  const result = await usageAsync(() => store.add(value, args.flags.get("--tag") ?? []));
  store.save();
  const tags = result.record.tags.length > 0 ? ` tags=[${result.record.tags.join(", ")}]` : "";
  out(`${result.added ? "added" : "updated"} ${result.record.id}${tags} (${plural(store.size, "subscription")} in store)`);
  return 0;
}

function cmdList(args: ParsedArgs): number {
  const store = SubscriptionStore.open(one(args, "--store") ?? DEFAULT_STORE);
  const records = store.list(one(args, "--tag"));
  if (has(args, "--json")) {
    out(JSON.stringify({ subscriptions: records }, null, 2));
    return 0;
  }
  if (records.length === 0) {
    out("no subscriptions");
    return 0;
  }
  for (const record of records) {
    const origin = new URL(record.endpoint).origin;
    const tags = record.tags.length > 0 ? `  [${record.tags.join(", ")}]` : "";
    out(`${record.id}  ${origin}${tags}`);
  }
  out(plural(records.length, "subscription"));
  return 0;
}

function cmdRemove(args: ParsedArgs): number {
  const target = args.positional[1];
  if (target === undefined) throw new UsageError("remove needs a subscription id or endpoint");
  const store = SubscriptionStore.open(one(args, "--store") ?? DEFAULT_STORE);
  if (!store.remove(target)) throw new OperationError(`no subscription matches ${JSON.stringify(target)}`);
  store.save();
  out(`removed ${target} (${plural(store.size, "subscription")} left)`);
  return 0;
}

async function cmdSend(args: ParsedArgs): Promise<number> {
  const message = await readTextArg(args.positional[1], "message");
  const vapid = loadVapid(args);
  const store = SubscriptionStore.open(one(args, "--store") ?? DEFAULT_STORE);
  const targets = selectTargets(args, store);
  const options = messageOptions(args);
  const dryRun = has(args, "--dry-run");
  const outDir = one(args, "--out");
  if (outDir !== undefined && !dryRun) throw new UsageError("--out only makes sense with --dry-run");
  if (outDir !== undefined && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  let failures = 0;
  for (const target of targets) {
    const request = await buildPushRequest(target, utf8(message), { ...options, vapid });
    if (dryRun) {
      out(`[dry-run] ${target.id} -> POST ${new URL(target.endpoint).origin} ` +
        `(body ${request.body.length} bytes, ttl ${request.headers.TTL})`);
      if (outDir !== undefined) {
        const bodyPath = join(outDir, `${target.id}.body`);
        writeBodyFile(bodyPath, request.body);
        writeFileSync(join(outDir, `${target.id}.headers.json`), JSON.stringify(request.headers, null, 2) + "\n");
        out(`  body -> ${bodyPath}`);
      }
      continue;
    }
    const response = await fetchTransport(request);
    const outcome = classifyStatus(response.status);
    out(`${target.id} -> ${response.status} ${outcome}`);
    if (outcome === "gone") {
      store.remove(target.id);
      store.save();
      out(`  pruned ${target.id} (push service says the subscription is dead)`);
    }
    if (outcome === "failed" || outcome === "retry") failures++;
  }
  if (failures > 0) throw new OperationError(`${plural(failures, "delivery", "deliveries")} not accepted — consider enqueue + drain for retries`);
  return 0;
}

async function cmdEnqueue(args: ParsedArgs): Promise<number> {
  const message = await readTextArg(args.positional[1], "message");
  const store = SubscriptionStore.open(one(args, "--store") ?? DEFAULT_STORE);
  const targets = selectTargets(args, store);
  const queue = DeliveryQueue.open(one(args, "--queue") ?? DEFAULT_QUEUE);
  const settings: { maxAttempts?: number } = {};
  const maxAttempts = intFlag(args, "--max-attempts");
  if (maxAttempts !== undefined) settings.maxAttempts = maxAttempts;
  const jobs = queue.enqueue(utf8(message), targets, messageOptions(args), settings);
  queue.save();
  out(`enqueued ${plural(jobs.length, "job")}: ${jobs.map((job) => job.id).join(", ")}`);
  return 0;
}

async function cmdDrain(args: ParsedArgs): Promise<number> {
  const queue = DeliveryQueue.open(one(args, "--queue") ?? DEFAULT_QUEUE);
  if (has(args, "--dry-run")) {
    const due = queue.due();
    for (const job of due) {
      out(`[dry-run] ${job.id} -> ${new URL(job.subscription.endpoint).origin} ` +
        `(attempt ${job.attempts + 1}/${job.maxAttempts})`);
    }
    out(`${plural(due.length, "job")} due`);
    return 0;
  }
  const vapid = loadVapid(args);
  const storePath = one(args, "--store");
  const store = storePath !== undefined ? SubscriptionStore.open(storePath) : undefined;
  const drainOptions = store !== undefined
    ? { vapid, transport: fetchTransport, store }
    : { vapid, transport: fetchTransport };
  const report = await queue.drain(drainOptions);
  queue.save();
  if (store) store.save();
  out(`attempted ${report.attempted}: ${report.sent} sent, ${report.retried} retried, ` +
    `${report.gone} gone, ${report.failed} failed`);
  if (report.goneSubscriptionIds.length > 0) {
    out(`pruned dead subscriptions: ${report.goneSubscriptionIds.join(", ")}`);
  }
  if (report.failed > 0) throw new OperationError(`${plural(report.failed, "job")} failed permanently`);
  return 0;
}

function cmdQueueStatus(args: ParsedArgs): number {
  const queue = DeliveryQueue.open(one(args, "--queue") ?? DEFAULT_QUEUE);
  if (has(args, "--clear-finished")) {
    const cleared = queue.clearFinished();
    queue.save();
    out(`cleared ${plural(cleared, "finished job")}`);
  }
  const stats = queue.stats();
  if (has(args, "--json")) {
    out(JSON.stringify({ stats, jobs: queue.list() }, null, 2));
    return 0;
  }
  for (const job of queue.list()) {
    const last = job.lastStatus !== undefined ? ` last=${job.lastStatus}` : "";
    out(`${job.id}  ${job.status}  attempts=${job.attempts}/${job.maxAttempts}${last}  ${job.subscriptionId}`);
  }
  out(`pending=${stats.pending} sent=${stats.sent} gone=${stats.gone} failed=${stats.failed}`);
  return 0;
}

async function cmdDecrypt(args: ParsedArgs): Promise<number> {
  const bodyPath = args.positional[1];
  if (bodyPath === undefined) throw new UsageError("decrypt needs the encrypted body file");
  const keysPath = one(args, "--keys") ?? DEFAULT_UA_KEYS;
  if (!existsSync(keysPath)) throw new UsageError(`subscriber key file ${keysPath} not found — run: pushforge mock`);
  const secrets = loadJsonFile<MockSubscriberSecrets>(keysPath, "mock-subscriber", {
    privateJwk: { kty: "EC", crv: "P-256", x: "", y: "", d: "" },
    auth: "",
  });
  let body: Uint8Array;
  try {
    body = readBodyFile(bodyPath);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  try {
    const plaintext = await decrypt(body, secrets.privateJwk, b64urlDecode(secrets.auth));
    out(utf8Decode(plaintext));
  } catch (err) {
    throw new OperationError(`decrypt failed: ${(err as Error).message}`);
  }
  return 0;
}

// -------------------------------------------------------------- body files

const BODY_MAGIC = "pushforge-body:";

/**
 * Encrypted bodies are persisted as one-line text files —
 * `pushforge-body:<base64url>` — so they are safe to cat, diff and paste,
 * and the fs ambient surface can stay utf8-only. `decrypt` reads the same
 * format back.
 */
function writeBodyFile(path: string, body: Uint8Array): void {
  writeFileSync(path, BODY_MAGIC + b64urlEncode(body) + "\n");
}

function readBodyFile(path: string): Uint8Array {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith(BODY_MAGIC)) {
    throw new Error(`${path} is not a pushforge body file (missing ${BODY_MAGIC} prefix)`);
  }
  return b64urlDecode(text.slice(BODY_MAGIC.length).trim());
}

// ------------------------------------------------------------------- main

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (has(args, "--version")) {
    out(VERSION);
    return 0;
  }
  const command = args.positional[0];
  if (has(args, "--help") || command === undefined || command === "help") {
    out(HELP.trimEnd());
    return command === undefined && !has(args, "--help") ? 2 : 0;
  }
  switch (command) {
    case "keygen": return cmdKeygen(args);
    case "mock": return cmdMock(args);
    case "add": return cmdAdd(args);
    case "list": return cmdList(args);
    case "remove": return cmdRemove(args);
    case "send": return cmdSend(args);
    case "enqueue": return cmdEnqueue(args);
    case "drain": return cmdDrain(args);
    case "queue-status": return cmdQueueStatus(args);
    case "decrypt": return cmdDecrypt(args);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)} (see pushforge --help)`);
  }
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pushforge: ${message}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
