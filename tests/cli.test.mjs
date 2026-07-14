/** CLI integration: the real built binary, run in fresh temp dirs, covering
 * the full offline pipeline (keygen -> mock -> add -> send --dry-run ->
 * decrypt) plus exit-code discipline. */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION } from "../dist/index.js";
import { runCli, tempDir } from "./helpers.mjs";

/** Bootstrap a workspace with VAPID keys, one mock subscriber, one add. */
function bootstrap(t, tags = ["--tag", "beta"]) {
  const cwd = tempDir(t);
  const keygen = runCli(["keygen", "--subject", "mailto:ops@example.test", "--out", "vapid.json"], { cwd });
  assert.equal(keygen.code, 0, keygen.stderr);
  const mock = runCli(["mock"], { cwd });
  assert.equal(mock.code, 0, mock.stderr);
  writeFileSync(join(cwd, "sub.json"), mock.stdout);
  const add = runCli(["add", "sub.json", ...tags], { cwd });
  assert.equal(add.code, 0, add.stderr);
  const id = add.stdout.match(/^(?:added|updated) ([0-9a-f]{12})/)[1];
  return { cwd, id };
}

test("--version prints the package version; --help documents every command", () => {
  const version = runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
  const help = runCli(["--help"]);
  assert.equal(help.code, 0);
  for (const word of ["keygen", "mock", "add", "list", "remove", "send", "enqueue", "drain", "queue-status", "decrypt"]) {
    assert.ok(help.stdout.includes(word), `help missing ${word}`);
  }
});

test("bare invocations, unknown commands and unknown flags exit 2", () => {
  assert.equal(runCli([]).code, 2, "no command prints help but exits 2 — a bare invocation is a mistake");
  const unknownCommand = runCli(["frobnicate"]);
  assert.equal(unknownCommand.code, 2);
  assert.match(unknownCommand.stderr, /unknown command/);
  const unknownFlag = runCli(["list", "--frobnicate"]);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /unknown flag/);
});

test("keygen writes a key file and prints the applicationServerKey", (t) => {
  const cwd = tempDir(t);
  const result = runCli(["keygen", "--subject", "mailto:ops@example.test", "--out", "vapid.json"], { cwd });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /applicationServerKey/);
  const file = JSON.parse(readFileSync(join(cwd, "vapid.json"), "utf8"));
  assert.equal(file.pushforge, "vapid");
  assert.match(file.data.publicKey, /^B[A-Za-z0-9_-]{86}$/, "65 raw bytes encode to 87 chars starting with B");
  assert.equal(file.data.subject, "mailto:ops@example.test");
});

test("keygen refuses to overwrite an existing key file without --force", (t) => {
  const cwd = tempDir(t);
  runCli(["keygen", "--out", "vapid.json"], { cwd });
  const second = runCli(["keygen", "--out", "vapid.json"], { cwd });
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already exists/);
  const forced = runCli(["keygen", "--out", "vapid.json", "--force"], { cwd });
  assert.equal(forced.code, 0);
});

test("mock emits a browser-shaped subscription and a separate secrets file", (t) => {
  const cwd = tempDir(t);
  const result = runCli(["mock"], { cwd });
  assert.equal(result.code, 0);
  const sub = JSON.parse(result.stdout);
  assert.match(sub.endpoint, /^https:\/\/push\.example\.test\/send\//);
  assert.match(sub.keys.p256dh, /^B[A-Za-z0-9_-]{86}$/);
  assert.ok(!result.stdout.includes('"d"'), "private key must not leak into the subscription");
  const secrets = JSON.parse(readFileSync(join(cwd, "ua-keys.json"), "utf8"));
  assert.equal(secrets.pushforge, "mock-subscriber");
  assert.equal(secrets.data.auth, sub.keys.auth);
});

test("add + list + remove manage the store end to end", (t) => {
  const { cwd, id } = bootstrap(t);
  const list = runCli(["list"], { cwd });
  assert.equal(list.code, 0);
  assert.ok(list.stdout.includes(id));
  assert.ok(list.stdout.includes("[beta]"));
  assert.ok(!list.stdout.includes("/send/"), "list must not echo full capability URLs");
  const remove = runCli(["remove", id], { cwd });
  assert.equal(remove.code, 0);
  const after = runCli(["list"], { cwd });
  assert.match(after.stdout, /no subscriptions/);
});

test("add accepts the subscription on stdin", (t) => {
  const cwd = tempDir(t);
  const mock = runCli(["mock"], { cwd });
  const add = runCli(["add", "-"], { cwd, input: mock.stdout });
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /^added [0-9a-f]{12}/);
});

test("add rejects invalid JSON and invalid subscriptions with exit 2", (t) => {
  const cwd = tempDir(t);
  const notJson = runCli(["add", "-"], { cwd, input: "{ nope" });
  assert.equal(notJson.code, 2);
  assert.match(notJson.stderr, /not valid JSON/);
  const badSub = runCli(["add", "-"], { cwd, input: '{"endpoint":"http://x.test","keys":{}}' });
  assert.equal(badSub.code, 2);
  assert.match(badSub.stderr, /endpoint must be https/);
});

test("send --dry-run + decrypt round-trips the message through real encryption", (t) => {
  const { cwd, id } = bootstrap(t);
  const message = "Deploy finished: v2.4.1 is live";
  const send = runCli(["send", message, "--vapid", "vapid.json", "--all", "--dry-run", "--out", "out"], { cwd });
  assert.equal(send.code, 0, send.stderr);
  assert.match(send.stdout, /\[dry-run\] [0-9a-f]{12} -> POST https:\/\/push\.example\.test/);
  const headers = JSON.parse(readFileSync(join(cwd, "out", `${id}.headers.json`), "utf8"));
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  assert.match(headers.Authorization, /^vapid t=/);
  const decrypt = runCli(["decrypt", join("out", `${id}.body`)], { cwd });
  assert.equal(decrypt.code, 0, decrypt.stderr);
  assert.equal(decrypt.stdout.trim(), message);
});

test("send validates targeting and options before building anything", (t) => {
  const { cwd } = bootstrap(t);
  const noTargets = runCli(["send", "x", "--vapid", "vapid.json"], { cwd });
  assert.equal(noTargets.code, 2);
  assert.match(noTargets.stderr, /no targets/);
  const badUrgency = runCli(["send", "x", "--vapid", "vapid.json", "--all", "--urgency", "asap", "--dry-run"], { cwd });
  assert.equal(badUrgency.code, 2);
  assert.match(badUrgency.stderr, /invalid urgency/);
  const noVapid = runCli(["send", "x", "--vapid", "missing.json", "--all", "--dry-run"], { cwd });
  assert.equal(noVapid.code, 2);
  assert.match(noVapid.stderr, /not found — run: pushforge keygen/);
});

test("decrypt with the wrong subscriber keys exits 1 (operation failed, not usage)", (t) => {
  const { cwd, id } = bootstrap(t);
  runCli(["send", "secret", "--vapid", "vapid.json", "--all", "--dry-run", "--out", "out"], { cwd });
  // Overwrite the secrets with a fresh mock: same file shape, wrong keys.
  runCli(["mock", "--keys-out", "ua-keys.json", "--force"], { cwd });
  const result = runCli(["decrypt", join("out", `${id}.body`)], { cwd });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /decrypt failed/);
});

test("enqueue + queue-status + drain --dry-run manage the queue offline", (t) => {
  const { cwd, id } = bootstrap(t);
  const enqueue = runCli(["enqueue", "queued hello", "--tag", "beta", "--ttl", "120"], { cwd });
  assert.equal(enqueue.code, 0, enqueue.stderr);
  assert.match(enqueue.stdout, /enqueued 1 job: job-1/);
  const status = runCli(["queue-status", "--json"], { cwd });
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.stats.pending, 1);
  assert.equal(parsed.jobs[0].subscriptionId, id);
  assert.equal(parsed.jobs[0].options.ttl, 120);
  const dry = runCli(["drain", "--dry-run"], { cwd });
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /1 job due/);
  const clear = runCli(["queue-status", "--clear-finished"], { cwd });
  assert.equal(clear.code, 0);
  assert.match(clear.stdout, /cleared 0 finished jobs/, "pending jobs survive --clear-finished");
  assert.match(clear.stdout, /pending=1/);
});

test("two dry-run sends with the same inputs still differ (fresh salt + AS keys)", (t) => {
  const { cwd, id } = bootstrap(t);
  runCli(["send", "same message", "--vapid", "vapid.json", "--all", "--dry-run", "--out", "a"], { cwd });
  runCli(["send", "same message", "--vapid", "vapid.json", "--all", "--dry-run", "--out", "b"], { cwd });
  const bodyA = readFileSync(join(cwd, "a", `${id}.body`), "utf8");
  const bodyB = readFileSync(join(cwd, "b", `${id}.body`), "utf8");
  assert.notEqual(bodyA, bodyB, "encryption must never reuse salt/keys across messages");
});
