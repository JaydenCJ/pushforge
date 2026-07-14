/** RFC 8292 VAPID: ES256 JWTs scoped to the push-service origin, carried in
 * a `vapid t=…, k=…` Authorization header. The signature is verified with
 * the real public key — not just shape-checked. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EXPIRATION_SECONDS,
  audienceFromEndpoint,
  buildVapidAuthorization,
  generateVapidKeys,
  signJwt,
  validateSubject,
  verifyJwt,
} from "../dist/index.js";

const ENDPOINT = "https://push.example.test/send/abc123";
const SUBJECT = "mailto:ops@example.test";
const NOW = 1_752_400_000_000; // fixed clock for deterministic claims

test("audienceFromEndpoint returns the origin only, and rejects non-https endpoints", () => {
  assert.equal(audienceFromEndpoint(ENDPOINT), "https://push.example.test");
  assert.equal(audienceFromEndpoint("https://push.example.test:8443/x/y"), "https://push.example.test:8443");
  assert.throws(() => audienceFromEndpoint("http://push.example.test/send/x"), /must be https/);
  assert.throws(() => audienceFromEndpoint("not a url"), /invalid endpoint URL/);
});

test("validateSubject accepts mailto: and https:, rejects everything else", () => {
  assert.equal(validateSubject(SUBJECT), SUBJECT);
  assert.equal(validateSubject("https://example.test/contact"), "https://example.test/contact");
  assert.throws(() => validateSubject("ops@example.test"), /must be a mailto: or https: URI/);
  assert.throws(() => validateSubject("mailto:"), /must be a mailto: or https: URI/);
  assert.throws(() => validateSubject("http://example.test"), /must be a mailto: or https: URI/);
});

test("signJwt produces a compact JWT that verifies against the public key", async () => {
  const keys = await generateVapidKeys();
  const token = await signJwt({ aud: "https://push.example.test", exp: 123, sub: SUBJECT }, keys);
  assert.equal(token.split(".").length, 3);
  const { header, payload } = await verifyJwt(token, keys.publicKey);
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  assert.deepEqual(payload, { aud: "https://push.example.test", exp: 123, sub: SUBJECT });
});

test("verifyJwt rejects a token signed by a different key", async () => {
  const keys = await generateVapidKeys();
  const impostor = await generateVapidKeys();
  const token = await signJwt({ aud: "https://push.example.test", exp: 1, sub: SUBJECT }, keys);
  await assert.rejects(verifyJwt(token, impostor.publicKey), /signature verification failed/);
});

test("verifyJwt rejects a token whose payload was swapped after signing", async () => {
  const keys = await generateVapidKeys();
  const token = await signJwt({ aud: "https://push.example.test", exp: 1, sub: SUBJECT }, keys);
  const forgedPayload = Buffer.from(JSON.stringify({ aud: "https://evil.example.test", exp: 1, sub: SUBJECT }))
    .toString("base64url");
  const [head, , sig] = token.split(".");
  await assert.rejects(verifyJwt(`${head}.${forgedPayload}.${sig}`, keys.publicKey), /signature verification failed/);
});

test("buildVapidAuthorization emits `vapid t=…, k=<public key>`", async () => {
  const keys = await generateVapidKeys();
  const header = await buildVapidAuthorization(ENDPOINT, { keys, subject: SUBJECT, now: NOW });
  const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(match, `unexpected header shape: ${header}`);
  assert.equal(match[2], keys.publicKey);
});

test("the embedded JWT carries aud=origin, sub, and exp = now + lifetime", async () => {
  const keys = await generateVapidKeys();
  const header = await buildVapidAuthorization(ENDPOINT, { keys, subject: SUBJECT, now: NOW });
  const token = header.match(/t=([^,]+),/)[1];
  const { payload } = await verifyJwt(token, keys.publicKey);
  assert.equal(payload.aud, "https://push.example.test");
  assert.equal(payload.sub, SUBJECT);
  assert.equal(payload.exp, Math.floor(NOW / 1000) + DEFAULT_EXPIRATION_SECONDS);
  const custom = await buildVapidAuthorization(ENDPOINT, { keys, subject: SUBJECT, now: NOW, expirationSeconds: 300 });
  const customToken = custom.match(/t=([^,]+),/)[1];
  const customPayload = (await verifyJwt(customToken, keys.publicKey)).payload;
  assert.equal(customPayload.exp, Math.floor(NOW / 1000) + 300, "a custom expiration is honored");
});

test("expirations beyond the RFC 8292 24h cap are rejected", async () => {
  const keys = await generateVapidKeys();
  await assert.rejects(
    buildVapidAuthorization(ENDPOINT, { keys, subject: SUBJECT, expirationSeconds: 86401 }),
    /RFC 8292 caps at 24h/,
  );
  await assert.rejects(
    buildVapidAuthorization(ENDPOINT, { keys, subject: SUBJECT, expirationSeconds: 0 }),
    /invalid VAPID expiration/,
  );
});

test("a fixed clock fixes the JWT claims (the ECDSA signature itself is randomized)", async () => {
  const keys = await generateVapidKeys();
  const options = { keys, subject: SUBJECT, now: NOW };
  const claims = async () => {
    const header = await buildVapidAuthorization(ENDPOINT, options);
    const token = header.match(/t=([^,]+),/)[1];
    return (await verifyJwt(token, keys.publicKey)).payload;
  };
  assert.deepEqual(await claims(), await claims());
});
