// Server-side API example: store -> queue -> drain, fully offline.
// Run from the repo root after `npm run build`:
//
//   node examples/send.mjs
//
// The transport is injected, so this demonstrates the exact production code
// path (encryption, VAPID headers, retry classification) without a network.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeliveryQueue,
  SubscriptionStore,
  createMockSubscriber,
  generateVapidKeys,
  // In production you would use the default transport (global fetch) by
  // simply not passing one: queue.drain({ vapid, transport: fetchTransport })
} from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "pushforge-example-"));

// 1. Your long-term server identity (in real life: load from vapid.json).
const keys = await generateVapidKeys();
const vapid = { keys, subject: "mailto:you@example.test" };

// 2. Two subscribers. In real life these arrive from the browser via your
//    backend; here the mock generates identical-shaped key material.
const store = SubscriptionStore.open(join(dir, "subscriptions.json"));
const alice = await store.add((await createMockSubscriber()).subscription, ["beta"]);
const bob = await store.add((await createMockSubscriber()).subscription, ["beta"]);
store.save();
console.log(`store: ${store.size} subscriptions (${alice.record.id}, ${bob.record.id})`);

// 3. Queue one message for everyone tagged "beta".
const queue = DeliveryQueue.open(join(dir, "queue.json"));
queue.enqueue("Release 1.2.0 is out — changelog inside", store.list("beta"), {
  ttl: 3600,
  urgency: "normal",
  topic: "releases",
});
queue.save();

// 4. A scripted transport: the push service accepts Alice's delivery and
//    reports Bob's subscription dead (he cleared his browser data).
const statuses = [201, 410];
let call = 0;
const transport = async (request) => {
  console.log(`POST ${new URL(request.endpoint).origin} (${request.body.length} bytes encrypted)`);
  return { status: statuses[call++] };
};

// 5. Drain: sends, classifies, prunes the dead subscription from the store.
const report = await queue.drain({ vapid, transport, store });
queue.save();
store.save();

console.log("drain report:", report);
console.log(`store after prune: ${store.size} subscription${store.size === 1 ? "" : "s"}`);

rmSync(dir, { recursive: true, force: true });
