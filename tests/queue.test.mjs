/** The delivery queue: retry/backoff state machine with an injected clock
 * and transport, so every timing scenario runs instantly and offline. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  DeliveryQueue,
  SubscriptionStore,
  backoffMs,
  createMockSubscriber,
  generateVapidKeys,
} from "../dist/index.js";
import { scriptedTransport, tempDir } from "./helpers.mjs";

const T0 = 1_752_400_000_000;

async function fixtures(t, subscriberCount = 1) {
  const dir = tempDir(t);
  const queue = DeliveryQueue.open(join(dir, "queue.json"));
  const store = SubscriptionStore.open(join(dir, "subscriptions.json"));
  const targets = [];
  for (let i = 0; i < subscriberCount; i++) {
    const mock = await createMockSubscriber();
    const { record } = await store.add(mock.subscription, [], T0 - 1000 + i);
    targets.push(record);
  }
  const keys = await generateVapidKeys();
  return { dir, queue, store, targets, vapid: { keys, subject: "mailto:ops@example.test" } };
}

test("enqueue creates one pending job per target with monotonic ids", async (t) => {
  const { queue, targets } = await fixtures(t, 3);
  const jobs = queue.enqueue("release 1.2.0 is out", targets, { ttl: 60 }, { now: T0 });
  assert.deepEqual(jobs.map((job) => job.id), ["job-1", "job-2", "job-3"]);
  assert.ok(jobs.every((job) => job.status === "pending" && job.attempts === 0 && job.notBefore === T0));
  assert.deepEqual(queue.stats(), { pending: 3, sent: 0, gone: 0, failed: 0 });
});

test("job ids keep counting across save/reopen (no id reuse ever)", async (t) => {
  const { queue, targets } = await fixtures(t);
  queue.enqueue("a", targets, {}, { now: T0 });
  queue.save();
  const reopened = DeliveryQueue.open(queue.path);
  const [job] = reopened.enqueue("b", targets, {}, { now: T0 });
  assert.equal(job.id, "job-2");
});

test("empty payloads and non-positive maxAttempts are refused at enqueue", async (t) => {
  const { queue, targets } = await fixtures(t);
  assert.throws(() => queue.enqueue("", targets), /payload must not be empty/);
  assert.throws(() => queue.enqueue("x", targets, {}, { maxAttempts: 0 }), /invalid maxAttempts/);
});

test("drain delivers due jobs and marks them sent on 201", async (t) => {
  const { queue, targets, vapid } = await fixtures(t, 2);
  queue.enqueue("hello", targets, {}, { now: T0 });
  const transport = scriptedTransport([201]);
  const report = await queue.drain({ vapid, transport, now: T0 });
  assert.deepEqual(report, { attempted: 2, sent: 2, gone: 0, retried: 0, failed: 0, goneSubscriptionIds: [] });
  assert.equal(transport.requests.length, 2);
  assert.ok(transport.requests.every((r) => r.headers["Content-Encoding"] === "aes128gcm"));
});

test("a 503 schedules a retry with exponential backoff, then succeeds", async (t) => {
  const { queue, targets, vapid } = await fixtures(t);
  const [job] = queue.enqueue("flaky", targets, {}, { now: T0 });
  const transport = scriptedTransport([503, 201]);

  const first = await queue.drain({ vapid, transport, now: T0 });
  assert.equal(first.retried, 1);
  assert.equal(job.status, "pending");
  assert.equal(job.notBefore, T0 + BACKOFF_BASE_MS, "first retry waits the base delay");

  // Still backing off: draining a second too early does nothing.
  const early = await queue.drain({ vapid, transport, now: T0 + BACKOFF_BASE_MS - 1 });
  assert.equal(early.attempted, 0);

  const second = await queue.drain({ vapid, transport, now: T0 + BACKOFF_BASE_MS });
  assert.equal(second.sent, 1);
  assert.equal(job.status, "sent");
  assert.equal(job.attempts, 2);
});

test("backoff grows 30s -> 2m -> 8m -> 32m and caps at 1h", () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(3), 480_000);
  assert.equal(backoffMs(4), 1_920_000);
  assert.equal(backoffMs(5), BACKOFF_CAP_MS);
  assert.equal(backoffMs(50), BACKOFF_CAP_MS, "never exceeds the cap");
});

test("retries exhaust into failed after maxAttempts", async (t) => {
  const { queue, targets, vapid } = await fixtures(t);
  const [job] = queue.enqueue("doomed", targets, {}, { now: T0, maxAttempts: 3 });
  const transport = scriptedTransport([500]);
  let now = T0;
  for (let i = 0; i < 3; i++) {
    await queue.drain({ vapid, transport, now });
    now = job.notBefore + 1;
  }
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, 3);
  assert.match(job.lastError, /gave up after 3 attempts/);
});

test("a transport exception counts as a retryable attempt (offline survival)", async (t) => {
  const { queue, targets, vapid } = await fixtures(t);
  const [job] = queue.enqueue("offline", targets, {}, { now: T0 });
  const transport = scriptedTransport(["throw", 201]);
  const first = await queue.drain({ vapid, transport, now: T0 });
  assert.equal(first.retried, 1);
  assert.match(job.lastError, /network unreachable/);
  const second = await queue.drain({ vapid, transport, now: job.notBefore });
  assert.equal(second.sent, 1);
});

test("410 marks the job gone and prunes the subscription from the store", async (t) => {
  const { queue, store, targets, vapid } = await fixtures(t, 2);
  queue.enqueue("prune me", targets, {}, { now: T0 });
  const transport = scriptedTransport([410, 201]);
  const report = await queue.drain({ vapid, transport, now: T0, store });
  assert.equal(report.gone, 1);
  assert.equal(report.sent, 1);
  assert.deepEqual(report.goneSubscriptionIds, [targets[0].id]);
  assert.equal(store.size, 1, "dead subscription was removed");
  assert.equal(store.get(targets[0].id), undefined);
});

test("a 400 fails permanently without retries", async (t) => {
  const { queue, targets, vapid } = await fixtures(t);
  const [job] = queue.enqueue("bad request", targets, {}, { now: T0 });
  const transport = scriptedTransport([400]);
  const report = await queue.drain({ vapid, transport, now: T0 });
  assert.equal(report.failed, 1);
  assert.equal(job.status, "failed");
  assert.equal(job.lastStatus, 400);
  const again = await queue.drain({ vapid, transport, now: T0 + BACKOFF_CAP_MS });
  assert.equal(again.attempted, 0, "failed jobs are never re-attempted");
});

test("queue state survives save/reopen mid-backoff", async (t) => {
  const { queue, targets, vapid } = await fixtures(t);
  queue.enqueue("persist", targets, {}, { now: T0 });
  await queue.drain({ vapid, transport: scriptedTransport([429]), now: T0 });
  queue.save();
  const reopened = DeliveryQueue.open(queue.path);
  const [job] = reopened.list();
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  assert.equal(job.notBefore, T0 + BACKOFF_BASE_MS);
  assert.equal(job.lastStatus, 429);
});

test("clearFinished drops sent/gone/failed jobs and keeps pending ones", async (t) => {
  const { queue, targets, vapid } = await fixtures(t, 3);
  queue.enqueue("mixed", targets, {}, { now: T0 });
  await queue.drain({ vapid, transport: scriptedTransport([201, 410, 503]), now: T0 });
  const cleared = queue.clearFinished();
  assert.equal(cleared, 2, "sent + gone cleared, retrying job kept");
  assert.equal(queue.size, 1);
  assert.equal(queue.list()[0].status, "pending");
});

test("foreign or corrupt queue files are refused loudly", async (t) => {
  const dir = tempDir(t);
  const { writeFileSync } = await import("node:fs");
  const path = join(dir, "queue.json");
  writeFileSync(path, JSON.stringify({ pushforge: "subscriptions", version: 1, data: {} }));
  assert.throws(() => DeliveryQueue.open(path), /not a pushforge queue file/);
});
