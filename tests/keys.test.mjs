/** Key plumbing: VAPID (ECDSA) and ECDH pairs must come out in the exact
 * wire shapes Web Push uses — 65-byte uncompressed points, 32-byte scalars. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRIVATE_KEY_LENGTH,
  PUBLIC_KEY_LENGTH,
  b64urlDecode,
  generateEcdhPair,
  generateVapidKeys,
  vapidPrivateJwk,
} from "../dist/index.js";

test("generateVapidKeys emits a 65-byte uncompressed point and a 32-byte scalar", async () => {
  const keys = await generateVapidKeys();
  const raw = b64urlDecode(keys.publicKey);
  assert.equal(raw.length, PUBLIC_KEY_LENGTH);
  assert.equal(raw[0], 0x04, "browsers require the uncompressed point format");
  assert.equal(b64urlDecode(keys.privateKey).length, PRIVATE_KEY_LENGTH);
});

test("two generated VAPID pairs differ (fresh randomness each call)", async () => {
  const a = await generateVapidKeys();
  const b = await generateVapidKeys();
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.privateKey, b.privateKey);
});

test("vapidPrivateJwk reconstructs a JWK whose coordinates match the public key", async () => {
  const keys = await generateVapidKeys();
  const jwk = vapidPrivateJwk(keys);
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.equal(jwk.d, keys.privateKey);
  const raw = b64urlDecode(keys.publicKey);
  assert.deepEqual(b64urlDecode(jwk.x), raw.slice(1, 33));
  assert.deepEqual(b64urlDecode(jwk.y), raw.slice(33, 65));
});

test("vapidPrivateJwk rejects a truncated public key", () => {
  assert.throws(
    () => vapidPrivateJwk({ publicKey: "AAAA", privateKey: "AAAA" }),
    /invalid P-256 public key: 3 bytes/,
  );
});

test("vapidPrivateJwk rejects a compressed-point public key", async () => {
  const keys = await generateVapidKeys();
  const raw = b64urlDecode(keys.publicKey);
  raw[0] = 0x02; // compressed form — valid EC, but not what Web Push wants
  const { b64urlEncode } = await import("../dist/index.js");
  assert.throws(
    () => vapidPrivateJwk({ publicKey: b64urlEncode(raw), privateKey: keys.privateKey }),
    /leading byte 0x2/,
  );
});

test("vapidPrivateJwk rejects a wrong-length private scalar", async () => {
  const keys = await generateVapidKeys();
  assert.throws(
    () => vapidPrivateJwk({ publicKey: keys.publicKey, privateKey: "AAAA" }),
    /invalid VAPID private key: 3 bytes/,
  );
});

test("generateEcdhPair returns a matching raw point and private JWK", async () => {
  const pair = await generateEcdhPair();
  assert.equal(pair.publicRaw.length, PUBLIC_KEY_LENGTH);
  assert.equal(pair.publicRaw[0], 0x04);
  assert.deepEqual(b64urlDecode(pair.privateJwk.x), pair.publicRaw.slice(1, 33));
  assert.deepEqual(b64urlDecode(pair.privateJwk.y), pair.publicRaw.slice(33, 65));
  assert.equal(b64urlDecode(pair.privateJwk.d).length, PRIVATE_KEY_LENGTH);
});
