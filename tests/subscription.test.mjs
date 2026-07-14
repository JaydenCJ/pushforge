/** Subscription validation: this is the trust boundary — subscriptions come
 * from client HTTP requests, so every field is checked before storage. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockSubscriber, subscriptionId, validateSubscription, validateTag } from "../dist/index.js";

test("a real (mock-generated) subscription validates and is normalized", async () => {
  const { subscription } = await createMockSubscriber();
  const normalized = validateSubscription(subscription);
  assert.equal(normalized.endpoint, subscription.endpoint);
  assert.deepEqual(normalized.keys, subscription.keys);
});

test("padded browser keys are normalized to unpadded base64url", async () => {
  const { subscription } = await createMockSubscriber();
  const padded = {
    ...subscription,
    keys: { p256dh: subscription.keys.p256dh + "=", auth: subscription.keys.auth + "==" },
  };
  const normalized = validateSubscription(padded);
  assert.equal(normalized.keys.p256dh, subscription.keys.p256dh);
  assert.equal(normalized.keys.auth, subscription.keys.auth);
});

test("non-object and null inputs are rejected", () => {
  for (const bad of [null, 42, "string", [], undefined]) {
    assert.throws(() => validateSubscription(bad), /must be a JSON object|endpoint must be a non-empty string/);
  }
});

test("http and malformed endpoints are rejected — push services are https-only", async () => {
  const { subscription } = await createMockSubscriber();
  assert.throws(
    () => validateSubscription({ ...subscription, endpoint: "http://push.example.test/send/x" }),
    /endpoint must be https/,
  );
  assert.throws(() => validateSubscription({ ...subscription, endpoint: "::nope::" }), /not a valid URL/);
});

test("missing or non-string keys are rejected field-by-field", async () => {
  const { subscription } = await createMockSubscriber();
  assert.throws(() => validateSubscription({ endpoint: subscription.endpoint }), /keys must be an object/);
  assert.throws(
    () => validateSubscription({ endpoint: subscription.endpoint, keys: { auth: subscription.keys.auth } }),
    /p256dh must be a string/,
  );
  assert.throws(
    () => validateSubscription({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh } }),
    /auth must be a string/,
  );
});

test("a p256dh key that is not a 65-byte point is rejected", async () => {
  const { subscription } = await createMockSubscriber();
  assert.throws(
    () => validateSubscription({ ...subscription, keys: { p256dh: "AAAA", auth: subscription.keys.auth } }),
    /p256dh: invalid P-256 public key/,
  );
});

test("an auth secret that does not decode to 16 bytes is rejected", async () => {
  const { subscription } = await createMockSubscriber();
  assert.throws(
    () => validateSubscription({ ...subscription, keys: { p256dh: subscription.keys.p256dh, auth: "AAAA" } }),
    /auth must decode to 16 bytes, got 3/,
  );
});

test("subscriptionId is a stable 12-hex-char digest of the endpoint", async () => {
  const a = await subscriptionId("https://push.example.test/send/one");
  const b = await subscriptionId("https://push.example.test/send/one");
  const c = await subscriptionId("https://push.example.test/send/two");
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, b, "same endpoint, same id");
  assert.notEqual(a, c, "different endpoint, different id");
});

test("validateTag accepts short tokens and rejects shell-hostile input", () => {
  assert.equal(validateTag("beta"), "beta");
  assert.equal(validateTag("team-42.eu_west"), "team-42.eu_west");
  assert.throws(() => validateTag(""), /invalid tag/);
  assert.throws(() => validateTag("has space"), /invalid tag/);
  assert.throws(() => validateTag("-leading"), /invalid tag/);
  assert.throws(() => validateTag("x".repeat(65)), /invalid tag/);
});
