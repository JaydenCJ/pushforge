/** RFC 8291 / RFC 8188 encryption: the interop-critical core. Anchored on
 * the RFC's own Appendix A vector, then exercised for structure, round-trips
 * at many sizes, padding, and tamper detection. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RECORD_SIZE,
  HEADER_LENGTH,
  b64urlDecode,
  b64urlEncode,
  createMockSubscriber,
  decrypt,
  encrypt,
  maxPlaintextLength,
  parseHeader,
} from "../dist/index.js";
import { RFC8291_VECTOR, jwkFrom } from "./helpers.mjs";

const V = RFC8291_VECTOR;

function vectorInputs() {
  return {
    plaintext: new TextEncoder().encode(V.plaintext),
    uaPublic: b64urlDecode(V.uaPublic),
    uaJwk: jwkFrom(V.uaPublic, V.uaPrivate, b64urlDecode, b64urlEncode),
    asKeys: {
      privateJwk: jwkFrom(V.asPublic, V.asPrivate, b64urlDecode, b64urlEncode),
      publicRaw: b64urlDecode(V.asPublic),
    },
    salt: b64urlDecode(V.salt),
    authSecret: b64urlDecode(V.authSecret),
  };
}

test("encrypt reproduces the RFC 8291 Appendix A body byte-for-byte", async () => {
  const { plaintext, uaPublic, asKeys, salt, authSecret } = vectorInputs();
  const body = await encrypt(plaintext, uaPublic, authSecret, { salt, asKeys });
  assert.equal(b64urlEncode(body), V.body);
});

test("decrypt recovers the RFC 8291 Appendix A plaintext", async () => {
  const { uaJwk, authSecret } = vectorInputs();
  const plaintext = await decrypt(b64urlDecode(V.body), uaJwk, authSecret);
  assert.equal(new TextDecoder().decode(plaintext), V.plaintext);
});

test("the header block carries the salt, record size and AS public key", async () => {
  const { plaintext, uaPublic, asKeys, salt, authSecret } = vectorInputs();
  const body = await encrypt(plaintext, uaPublic, authSecret, { salt, asKeys });
  const header = parseHeader(body);
  assert.deepEqual(header.salt, salt);
  assert.equal(header.recordSize, DEFAULT_RECORD_SIZE);
  assert.deepEqual(header.keyId, asKeys.publicRaw);
  assert.equal(header.headerLength, HEADER_LENGTH);
});

test("round-trip succeeds at 1 byte, boundary sizes and the max payload", async () => {
  const mock = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  const auth = b64urlDecode(mock.secrets.auth);
  for (const size of [1, 2, 3, 100, 1024, maxPlaintextLength()]) {
    const plaintext = new Uint8Array(size);
    for (let i = 0; i < size; i++) plaintext[i] = (i * 31) & 0xff;
    const body = await encrypt(plaintext, uaPublic, auth);
    assert.deepEqual(await decrypt(body, mock.secrets.privateJwk, auth), plaintext, `size ${size}`);
  }
});

test("ephemeral AS keys make two encryptions of the same message differ", async () => {
  const mock = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  const auth = b64urlDecode(mock.secrets.auth);
  const a = await encrypt(new TextEncoder().encode("hi"), uaPublic, auth);
  const b = await encrypt(new TextEncoder().encode("hi"), uaPublic, auth);
  assert.notDeepEqual(a, b, "salt and AS key must be fresh per message");
});

test("fixed salt + fixed AS keys make encryption fully deterministic", async () => {
  const { plaintext, uaPublic, asKeys, salt, authSecret } = vectorInputs();
  const a = await encrypt(plaintext, uaPublic, authSecret, { salt, asKeys });
  const b = await encrypt(plaintext, uaPublic, authSecret, { salt, asKeys });
  assert.deepEqual(a, b);
});

test("padding hides the plaintext length but decrypts to the same bytes", async () => {
  const mock = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  const auth = b64urlDecode(mock.secrets.auth);
  const plaintext = new TextEncoder().encode("ok");
  const bare = await encrypt(plaintext, uaPublic, auth);
  const padded = await encrypt(plaintext, uaPublic, auth, { padding: 64 });
  assert.equal(padded.length, bare.length + 64);
  assert.deepEqual(await decrypt(padded, mock.secrets.privateJwk, auth), plaintext);
});

test("plaintext over the single-record budget is rejected with the budget in the message", async () => {
  const mock = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  const auth = b64urlDecode(mock.secrets.auth);
  const oversized = new Uint8Array(maxPlaintextLength() + 1);
  await assert.rejects(encrypt(oversized, uaPublic, auth), /plaintext too long/);
});

test("padding that pushes past the record budget is rejected", async () => {
  const mock = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  const auth = b64urlDecode(mock.secrets.auth);
  const plaintext = new Uint8Array(maxPlaintextLength());
  await assert.rejects(encrypt(plaintext, uaPublic, auth, { padding: 1 }), /plaintext too long/);
});

test("a flipped ciphertext bit fails authentication, not silently corrupts", async () => {
  const mock = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  const auth = b64urlDecode(mock.secrets.auth);
  const body = await encrypt(new TextEncoder().encode("integrity matters"), uaPublic, auth);
  body[body.length - 1] ^= 0x01;
  await assert.rejects(decrypt(body, mock.secrets.privateJwk, auth), /decryption failed/);
});

test("the wrong auth secret or wrong subscriber private key fails cleanly", async () => {
  const mock = await createMockSubscriber();
  const other = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  const auth = b64urlDecode(mock.secrets.auth);
  const body = await encrypt(new TextEncoder().encode("x"), uaPublic, auth);
  await assert.rejects(decrypt(body, mock.secrets.privateJwk, b64urlDecode(other.secrets.auth)), /decryption failed/);
  await assert.rejects(decrypt(body, other.secrets.privateJwk, auth), /decryption failed/);
});

test("parseHeader rejects truncated bodies and non-Web-Push keyid lengths", async () => {
  assert.throws(() => parseHeader(new Uint8Array(10)), /body too short/);
  const { plaintext, uaPublic, asKeys, salt, authSecret } = vectorInputs();
  const body = await encrypt(plaintext, uaPublic, authSecret, { salt, asKeys });
  body[20] = 12; // claim a 12-byte keyid — aes128gcm allows it, Web Push does not
  assert.throws(() => parseHeader(body), /unsupported keyid length 12/);
});

test("wrong auth secret length is rejected before any crypto runs", async () => {
  const mock = await createMockSubscriber();
  const uaPublic = b64urlDecode(mock.subscription.keys.p256dh);
  await assert.rejects(encrypt(new Uint8Array(1), uaPublic, new Uint8Array(15)), /invalid auth secret: 15 bytes/);
});
