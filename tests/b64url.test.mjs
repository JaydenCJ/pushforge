/** Base64url codec: Web Push is base64url end to end, so the codec must be
 * exact on every length remainder and loud on malformed input. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode } from "../dist/index.js";

test("encode produces the RFC 4648 §5 alphabet with no padding", () => {
  const bytes = new Uint8Array([251, 255, 190, 239]);
  const encoded = b64urlEncode(bytes);
  assert.equal(encoded, "-_--7w");
  assert.ok(!encoded.includes("="), "must be unpadded");
  assert.ok(!encoded.includes("+") && !encoded.includes("/"), "must not use the standard alphabet");
});

test("empty input and all three length remainders round-trip byte-identically", () => {
  assert.equal(b64urlEncode(new Uint8Array(0)), "");
  assert.deepEqual(b64urlDecode(""), new Uint8Array(0));
  for (const length of [1, 2, 3, 4, 5, 31, 32, 33, 64, 65]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) & 0xff;
    assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes, `length ${length}`);
  }
});

test("every byte value 0..255 survives a round-trip", () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
});

test("trailing = padding is tolerated (some browsers emit padded keys)", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const padded = b64urlEncode(bytes) + "==";
  assert.deepEqual(b64urlDecode(padded), bytes);
});

test("standard-alphabet, whitespace and non-ASCII characters are rejected, not skipped", () => {
  assert.throws(() => b64urlDecode("a+b"), /invalid base64url character/);
  assert.throws(() => b64urlDecode("a/b"), /invalid base64url character/);
  assert.throws(() => b64urlDecode("ab c"), /invalid base64url character/);
  assert.throws(() => b64urlDecode("ab\nc"), /invalid base64url character/);
  assert.throws(() => b64urlDecode("abcé"), /invalid base64url character/);
  assert.throws(() => b64urlDecode("abcde"), /invalid base64url length/, "a length-1 remainder is impossible");
});

test("decode matches a known vector from the RFC 8291 test data", () => {
  const salt = b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw");
  assert.equal(salt.length, 16);
  assert.equal(salt[0], 0x0c);
  assert.equal(salt[15], 0x97);
});
