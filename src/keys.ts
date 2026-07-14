/**
 * P-256 key plumbing on top of Node's WebCrypto: VAPID (ECDSA) application
 * server keys and per-message ephemeral ECDH pairs for RFC 8291. All wire
 * formats are the ones Web Push actually uses — 65-byte uncompressed public
 * points and 32-byte private scalars, base64url.
 */

import { b64urlDecode, b64urlEncode, concatBytes } from "./b64url.js";
import type { EcPrivateJwk, VapidKeys } from "./types.js";

const CURVE = "P-256" as const;
export const PUBLIC_KEY_LENGTH = 65;
export const PRIVATE_KEY_LENGTH = 32;
export const AUTH_SECRET_LENGTH = 16;

/** Assemble the 65-byte uncompressed point 0x04 || x || y from a JWK. */
export function rawPublicFromJwk(jwk: { x: string; y: string }): Uint8Array {
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`invalid P-256 coordinates: x=${x.length} y=${y.length} bytes (want 32/32)`);
  }
  return concatBytes(new Uint8Array([0x04]), x, y);
}

/** Split a 65-byte uncompressed point into base64url x/y JWK coordinates. */
export function jwkCoordinatesFromRaw(raw: Uint8Array): { x: string; y: string } {
  assertRawPublicKey(raw);
  return { x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)) };
}

/** Validate the shape of an uncompressed P-256 public point. */
export function assertRawPublicKey(raw: Uint8Array): void {
  if (raw.length !== PUBLIC_KEY_LENGTH) {
    throw new Error(`invalid P-256 public key: ${raw.length} bytes (want ${PUBLIC_KEY_LENGTH})`);
  }
  if (raw[0] !== 0x04) {
    throw new Error(`invalid P-256 public key: leading byte 0x${(raw[0] as number).toString(16)} (want 0x04, uncompressed)`);
  }
}

/** Generate a long-term VAPID (ECDSA P-256) application server key pair. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: CURVE }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d) throw new Error("key generation produced no private scalar");
  return { publicKey: b64urlEncode(rawPublicFromJwk(jwk)), privateKey: jwk.d };
}

/** Rebuild the full private JWK from the compact public/private pair. */
export function vapidPrivateJwk(keys: VapidKeys): EcPrivateJwk {
  const raw = b64urlDecode(keys.publicKey);
  assertRawPublicKey(raw);
  const d = b64urlDecode(keys.privateKey);
  if (d.length !== PRIVATE_KEY_LENGTH) {
    throw new Error(`invalid VAPID private key: ${d.length} bytes (want ${PRIVATE_KEY_LENGTH})`);
  }
  return { kty: "EC", crv: CURVE, ...jwkCoordinatesFromRaw(raw), d: keys.privateKey };
}

/** Import the VAPID private key for ES256 signing. */
export async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { ...vapidPrivateJwk(keys), ext: true }, { name: "ECDSA", namedCurve: CURVE }, false, ["sign"]);
}

/** Import a base64url VAPID public key for signature verification. */
export async function importVapidVerifyKey(publicKey: string): Promise<CryptoKey> {
  const raw = b64urlDecode(publicKey);
  assertRawPublicKey(raw);
  return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: CURVE }, false, ["verify"]);
}

/** An ECDH pair in the two forms RFC 8291 needs: a raw point and a CryptoKey. */
export interface EcdhPair {
  publicRaw: Uint8Array;
  privateKey: CryptoKey;
  privateJwk: EcPrivateJwk;
}

/** Generate an ephemeral ECDH pair (one per encrypted message). */
export async function generateEcdhPair(): Promise<EcdhPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d) throw new Error("key generation produced no private scalar");
  const privateJwk: EcPrivateJwk = { kty: "EC", crv: CURVE, x: jwk.x, y: jwk.y, d: jwk.d };
  return { publicRaw: rawPublicFromJwk(jwk), privateKey: pair.privateKey, privateJwk };
}

/** Import a private JWK for ECDH derivation (either side of RFC 8291). */
export async function importEcdhPrivate(jwk: EcPrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"]);
}

/** Import a 65-byte uncompressed point as the ECDH peer public key. */
export async function importEcdhPublic(raw: Uint8Array): Promise<CryptoKey> {
  assertRawPublicKey(raw);
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: CURVE }, false, []);
}

/** Random bytes helper (auth secrets, salts). */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
