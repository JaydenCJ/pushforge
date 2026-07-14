/** The subscription store: idempotent adds, tag routing, atomic persistence,
 * and loud failures on foreign or corrupt files. All state lives in fresh
 * temp dirs — no test touches another's files. */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SubscriptionStore, createMockSubscriber } from "../dist/index.js";
import { tempDir } from "./helpers.mjs";

async function freshStore(t) {
  const dir = tempDir(t);
  return { store: SubscriptionStore.open(join(dir, "subscriptions.json")), dir };
}

test("open on a missing file yields an empty store", async (t) => {
  const { store } = await freshStore(t);
  assert.equal(store.size, 0);
  assert.deepEqual(store.list(), []);
});

test("add validates, assigns a stable id, and persists across reopen", async (t) => {
  const { store } = await freshStore(t);
  const { subscription } = await createMockSubscriber();
  const { record, added } = await store.add(subscription, ["beta"], 1000);
  assert.ok(added);
  assert.match(record.id, /^[0-9a-f]{12}$/);
  store.save();
  const reopened = SubscriptionStore.open(store.path);
  assert.equal(reopened.size, 1);
  assert.deepEqual(reopened.get(record.id).keys, subscription.keys);
  assert.deepEqual(reopened.get(record.id).tags, ["beta"]);
});

test("re-adding the same endpoint is idempotent and merges tags", async (t) => {
  const { store } = await freshStore(t);
  const { subscription } = await createMockSubscriber();
  await store.add(subscription, ["beta"], 1000);
  const second = await store.add(subscription, ["ops"], 2000);
  assert.equal(second.added, false, "same endpoint must not duplicate");
  assert.equal(store.size, 1);
  assert.deepEqual(second.record.tags, ["beta", "ops"]);
  assert.equal(second.record.createdAt, 1000, "original creation time is kept");
});

test("re-adding with rotated keys updates the stored key material", async (t) => {
  const { store } = await freshStore(t);
  const a = await createMockSubscriber("https://push.example.test/send/fixed");
  const b = await createMockSubscriber("https://push.example.test/send/fixed");
  await store.add(a.subscription, [], 1000);
  await store.add(b.subscription, [], 2000);
  assert.equal(store.size, 1);
  assert.deepEqual(store.list()[0].keys, b.subscription.keys, "browser resubscribed with new keys");
});

test("invalid subscriptions never reach the store", async (t) => {
  const { store } = await freshStore(t);
  await assert.rejects(store.add({ endpoint: "http://x.test", keys: {} }), /endpoint must be https/);
  assert.equal(store.size, 0);
});

test("remove works by id and by endpoint, and reports misses", async (t) => {
  const { store } = await freshStore(t);
  const a = await createMockSubscriber();
  const b = await createMockSubscriber();
  const { record } = await store.add(a.subscription);
  await store.add(b.subscription);
  assert.ok(store.remove(record.id));
  assert.ok(store.remove(b.subscription.endpoint));
  assert.equal(store.remove("no-such-id"), false);
  assert.equal(store.size, 0);
});

test("list is ordered oldest-first and filters by tag", async (t) => {
  const { store } = await freshStore(t);
  const a = await createMockSubscriber();
  const b = await createMockSubscriber();
  const c = await createMockSubscriber();
  await store.add(b.subscription, ["ops"], 2000);
  await store.add(a.subscription, ["beta"], 1000);
  await store.add(c.subscription, ["beta", "ops"], 3000);
  assert.deepEqual(store.list().map((r) => r.createdAt), [1000, 2000, 3000]);
  assert.equal(store.list("beta").length, 2);
  assert.equal(store.list("ops").length, 2);
  assert.equal(store.list("nope").length, 0);
});

test("select resolves --all / --tag / ids, and refuses empty matches", async (t) => {
  const { store } = await freshStore(t);
  const a = await createMockSubscriber();
  const { record } = await store.add(a.subscription, ["beta"]);
  assert.equal(store.select({ all: true }).length, 1);
  assert.equal(store.select({ tag: "beta" }).length, 1);
  assert.equal(store.select({ ids: [record.id] })[0].id, record.id);
  assert.throws(() => store.select({ tag: "ghost" }), /no subscriptions tagged "ghost"/);
  assert.throws(() => store.select({ ids: ["beef00000000"] }), /no subscription with id/);
  assert.throws(() => store.select({}), /no targets/);
});

test("select on an empty store with --all names the problem", async (t) => {
  const { store } = await freshStore(t);
  assert.throws(() => store.select({ all: true }), /store is empty/);
});

test("corrupt or foreign JSON files are loud errors, not silent data loss", async (t) => {
  const dir = tempDir(t);
  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, "{ not json");
  assert.throws(() => SubscriptionStore.open(corrupt), /not valid JSON/);
  const foreign = join(dir, "foreign.json");
  writeFileSync(foreign, JSON.stringify({ some: "other tool's file" }));
  assert.throws(() => SubscriptionStore.open(foreign), /not a pushforge subscriptions file/);
});

test("save writes a versioned envelope and no temp file remains", async (t) => {
  const { store, dir } = await freshStore(t);
  const { subscription } = await createMockSubscriber();
  await store.add(subscription);
  store.save();
  const onDisk = JSON.parse(readFileSync(store.path, "utf8"));
  assert.equal(onDisk.pushforge, "subscriptions");
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.data.subscriptions.length, 1);
  const { readdirSync } = await import("node:fs");
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "atomic rename leaves no temp file");
});
