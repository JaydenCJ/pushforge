/** Request building: the exact RFC 8030 header set, the encrypted body, the
 * 4096-byte service cap, and status classification. The built request is
 * verified end to end by decrypting it with the subscriber's keys. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TTL_SECONDS,
  b64urlDecode,
  buildPushRequest,
  classifyStatus,
  createMockSubscriber,
  decrypt,
  generateVapidKeys,
  sendNotification,
  validateTopic,
  validateTtl,
  validateUrgency,
} from "../dist/index.js";
import { scriptedTransport } from "./helpers.mjs";

const SUBJECT = "mailto:ops@example.test";

async function fixtures() {
  const mock = await createMockSubscriber();
  const keys = await generateVapidKeys();
  return { mock, vapid: { keys, subject: SUBJECT, now: 1_752_400_000_000 } };
}

test("buildPushRequest emits the full RFC 8030 header set", async () => {
  const { mock, vapid } = await fixtures();
  const request = await buildPushRequest(mock.subscription, "hello", { vapid });
  assert.equal(request.method, "POST");
  assert.equal(request.endpoint, mock.subscription.endpoint);
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.equal(request.headers["Content-Type"], "application/octet-stream");
  assert.equal(request.headers.TTL, String(DEFAULT_TTL_SECONDS));
  assert.equal(request.headers["Content-Length"], String(request.body.length));
  assert.match(request.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.equal(request.headers.Urgency, undefined, "urgency is omitted unless set");
  assert.equal(request.headers.Topic, undefined, "topic is omitted unless set");
});

test("the built body decrypts to the original payload with the subscriber keys", async () => {
  const { mock, vapid } = await fixtures();
  const request = await buildPushRequest(mock.subscription, "round-trip proof", { vapid });
  const plaintext = await decrypt(request.body, mock.secrets.privateJwk, b64urlDecode(mock.secrets.auth));
  assert.equal(new TextDecoder().decode(plaintext), "round-trip proof");
});

test("ttl, urgency and topic flow into their headers", async () => {
  const { mock, vapid } = await fixtures();
  const request = await buildPushRequest(mock.subscription, "x", {
    vapid, ttl: 60, urgency: "high", topic: "deploys",
  });
  assert.equal(request.headers.TTL, "60");
  assert.equal(request.headers.Urgency, "high");
  assert.equal(request.headers.Topic, "deploys");
});

test("empty payloads are refused (a display-less push is a footgun)", async () => {
  const { mock, vapid } = await fixtures();
  await assert.rejects(buildPushRequest(mock.subscription, "", { vapid }), /payload must not be empty/);
});

test("payloads that encrypt past the 4096-byte service cap are refused", async () => {
  const { mock, vapid } = await fixtures();
  await assert.rejects(
    buildPushRequest(mock.subscription, "x".repeat(4100), { vapid }),
    /plaintext too long|push services cap/,
  );
});

test("validateTtl accepts 0 (deliver-now-or-drop) and rejects negatives/floats", () => {
  assert.equal(validateTtl(0), 0);
  assert.equal(validateTtl(2419200), 2419200);
  assert.throws(() => validateTtl(-1), /invalid TTL/);
  assert.throws(() => validateTtl(1.5), /invalid TTL/);
});

test("validateTopic and validateUrgency enforce the RFC 8030 value spaces", () => {
  assert.equal(validateTopic("deploys"), "deploys");
  assert.equal(validateTopic("A-Z_09".padEnd(32, "x")), "A-Z_09".padEnd(32, "x"));
  assert.throws(() => validateTopic("x".repeat(33)), /invalid topic/);
  assert.throws(() => validateTopic("has space"), /invalid topic/);
  assert.throws(() => validateTopic(""), /invalid topic/);
  for (const urgency of ["very-low", "low", "normal", "high"]) {
    assert.equal(validateUrgency(urgency), urgency);
  }
  assert.throws(() => validateUrgency("urgent"), /invalid urgency/);
});

test("classifyStatus maps the push-service contract", () => {
  assert.equal(classifyStatus(200), "sent");
  assert.equal(classifyStatus(201), "sent");
  assert.equal(classifyStatus(202), "sent");
  assert.equal(classifyStatus(404), "gone");
  assert.equal(classifyStatus(410), "gone");
  assert.equal(classifyStatus(429), "retry");
  assert.equal(classifyStatus(500), "retry");
  assert.equal(classifyStatus(503), "retry");
  assert.equal(classifyStatus(400), "failed");
  assert.equal(classifyStatus(401), "failed");
  assert.equal(classifyStatus(413), "failed");
});

test("sendNotification pushes one request through the transport and classifies it", async () => {
  const { mock, vapid } = await fixtures();
  const transport = scriptedTransport([201]);
  const result = await sendNotification(mock.subscription, "via transport", { vapid }, transport);
  assert.deepEqual(result, { status: 201, outcome: "sent" });
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].endpoint, mock.subscription.endpoint);
});
