/**
 * RFC 8291 message encryption for Web Push, on the RFC 8188 `aes128gcm`
 * content encoding. This is the exact construction every browser's push
 * service requires: ECDH over P-256 between an ephemeral application-server
 * key and the subscription's `p256dh` key, two HKDF stages keyed by the
 * `auth` secret, then a single AES-128-GCM record with a 0x02 delimiter.
 *
 * Both directions are implemented. `encrypt` is what a sender needs;
 * `decrypt` is what a browser does, and having it in-repo is what lets the
 * whole pipeline be verified offline (see tests and `pushforge decrypt`).
 */

import { b64urlDecode, concatBytes, utf8 } from "./b64url.js";
import {
  AUTH_SECRET_LENGTH,
  PUBLIC_KEY_LENGTH,
  assertRawPublicKey,
  generateEcdhPair,
  importEcdhPrivate,
  importEcdhPublic,
  randomBytes,
} from "./keys.js";
import type { EcPrivateJwk } from "./types.js";

export const SALT_LENGTH = 16;
export const TAG_LENGTH = 16;
export const DEFAULT_RECORD_SIZE = 4096;
/** salt(16) + rs(4) + idlen(1) + keyid(65) — fixed for Web Push. */
export const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + PUBLIC_KEY_LENGTH;
/** The record delimiter for the final (here: only) record, per RFC 8188. */
const LAST_RECORD_DELIMITER = 0x02;

const KEY_INFO_PREFIX = "WebPush: info\0";
const CEK_INFO = utf8("Content-Encoding: aes128gcm\0");
const NONCE_INFO = utf8("Content-Encoding: nonce\0");

export interface EncryptOptions {
  /** 16-byte salt; random when omitted. Fix it only for tests/vectors. */
  salt?: Uint8Array;
  /** Application-server ECDH key; ephemeral per message when omitted. */
  asKeys?: { privateJwk: EcPrivateJwk; publicRaw: Uint8Array };
  /** RFC 8188 record size. Default 4096, the value push services expect. */
  recordSize?: number;
  /** Extra zero-padding bytes, to hide the plaintext length. Default 0. */
  padding?: number;
}

/** Parsed RFC 8188 header block. */
export interface EceHeader {
  salt: Uint8Array;
  recordSize: number;
  /** The application server's ephemeral public key (65 bytes for Web Push). */
  keyId: Uint8Array;
  headerLength: number;
}

/** Largest plaintext that fits one record of `recordSize` with no padding. */
export function maxPlaintextLength(recordSize: number = DEFAULT_RECORD_SIZE): number {
  return recordSize - TAG_LENGTH - 1;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * RFC 8291 §3.3–3.4: combine the ECDH secret with the auth secret, then with
 * the salt, to produce the content-encryption key and nonce.
 */
async function deriveCekAndNonce(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  const keyInfo = concatBytes(utf8(KEY_INFO_PREFIX), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);
  return { cek, nonce };
}

function assertAuthSecret(authSecret: Uint8Array): void {
  if (authSecret.length !== AUTH_SECRET_LENGTH) {
    throw new Error(`invalid auth secret: ${authSecret.length} bytes (want ${AUTH_SECRET_LENGTH})`);
  }
}

/**
 * Encrypt `plaintext` for the subscriber identified by `uaPublicRaw` (the
 * `p256dh` key) and `authSecret` (the `auth` secret). Returns the complete
 * HTTP body: header block followed by one encrypted record.
 */
export async function encrypt(
  plaintext: Uint8Array,
  uaPublicRaw: Uint8Array,
  authSecret: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  assertRawPublicKey(uaPublicRaw);
  assertAuthSecret(authSecret);

  const salt = options.salt ?? randomBytes(SALT_LENGTH);
  if (salt.length !== SALT_LENGTH) {
    throw new Error(`invalid salt: ${salt.length} bytes (want ${SALT_LENGTH})`);
  }
  const recordSize = options.recordSize ?? DEFAULT_RECORD_SIZE;
  if (!Number.isInteger(recordSize) || recordSize < TAG_LENGTH + 2) {
    throw new Error(`invalid record size: ${recordSize} (minimum ${TAG_LENGTH + 2})`);
  }
  const padding = options.padding ?? 0;
  if (!Number.isInteger(padding) || padding < 0) {
    throw new Error(`invalid padding: ${padding}`);
  }
  const budget = maxPlaintextLength(recordSize);
  if (plaintext.length + padding > budget) {
    throw new Error(
      `plaintext too long: ${plaintext.length} bytes + ${padding} padding exceeds the ` +
        `${budget}-byte single-record budget (record size ${recordSize})`,
    );
  }

  const asKeys = options.asKeys ?? (await generateEcdhPair());
  const asPublic = asKeys.publicRaw;
  assertRawPublicKey(asPublic);
  const asPrivate = await importEcdhPrivate(asKeys.privateJwk);

  const uaPublicKey = await importEcdhPublic(uaPublicRaw);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asPrivate, 256));
  const { cek, nonce } = await deriveCekAndNonce(ecdhSecret, authSecret, uaPublicRaw, asPublic, salt);

  const record = concatBytes(plaintext, new Uint8Array([LAST_RECORD_DELIMITER]), new Uint8Array(padding));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  return concatBytes(buildHeader(salt, recordSize, asPublic), ciphertext);
}

function buildHeader(salt: Uint8Array, recordSize: number, keyId: Uint8Array): Uint8Array {
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  header[16] = (recordSize >>> 24) & 0xff;
  header[17] = (recordSize >>> 16) & 0xff;
  header[18] = (recordSize >>> 8) & 0xff;
  header[19] = recordSize & 0xff;
  header[20] = keyId.length;
  header.set(keyId, 21);
  return header;
}

/** Parse the RFC 8188 header block from an encrypted body. */
export function parseHeader(body: Uint8Array): EceHeader {
  if (body.length < SALT_LENGTH + 4 + 1) {
    throw new Error(`body too short for an aes128gcm header: ${body.length} bytes`);
  }
  const salt = body.slice(0, SALT_LENGTH);
  const recordSize =
    ((body[16] as number) << 24) | ((body[17] as number) << 16) | ((body[18] as number) << 8) | (body[19] as number);
  const keyIdLength = body[20] as number;
  const headerLength = SALT_LENGTH + 4 + 1 + keyIdLength;
  if (body.length < headerLength) {
    throw new Error(`truncated aes128gcm header: keyid says ${keyIdLength} bytes, body has ${body.length}`);
  }
  if (keyIdLength !== PUBLIC_KEY_LENGTH) {
    throw new Error(`unsupported keyid length ${keyIdLength}: Web Push requires a ${PUBLIC_KEY_LENGTH}-byte P-256 point`);
  }
  return { salt, recordSize: recordSize >>> 0, keyId: body.slice(21, headerLength), headerLength };
}

/**
 * Decrypt an `aes128gcm` body exactly as a browser would, given the
 * subscription's private key material. Only single-record bodies are
 * accepted (every Web Push message is one; push services cap the body at
 * 4096 bytes).
 */
export async function decrypt(body: Uint8Array, uaPrivateJwk: EcPrivateJwk, authSecret: Uint8Array): Promise<Uint8Array> {
  assertAuthSecret(authSecret);
  const header = parseHeader(body);
  const ciphertext = body.slice(header.headerLength);
  if (ciphertext.length < TAG_LENGTH + 1) {
    throw new Error(`ciphertext too short: ${ciphertext.length} bytes`);
  }
  if (ciphertext.length > header.recordSize) {
    throw new Error(
      `multi-record body (record size ${header.recordSize}, ciphertext ${ciphertext.length} bytes): not supported in 0.1.0`,
    );
  }

  const uaPrivate = await importEcdhPrivate(uaPrivateJwk);
  const uaPublicRaw = rawFromJwkCoords(uaPrivateJwk);
  const asPublicKey = await importEcdhPublic(header.keyId);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asPublicKey }, uaPrivate, 256));
  const { cek, nonce } = await deriveCekAndNonce(ecdhSecret, authSecret, uaPublicRaw, header.keyId, header.salt);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  let record: Uint8Array;
  try {
    record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext));
  } catch {
    throw new Error("decryption failed: wrong keys, wrong auth secret, or corrupted body");
  }
  return stripPadding(record);
}

function rawFromJwkCoords(jwk: EcPrivateJwk): Uint8Array {
  return concatBytes(new Uint8Array([0x04]), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
}

/** Remove trailing zero padding and the 0x02 last-record delimiter. */
function stripPadding(record: Uint8Array): Uint8Array {
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (end < 0 || record[end] !== LAST_RECORD_DELIMITER) {
    throw new Error("invalid record: missing 0x02 last-record delimiter");
  }
  return record.slice(0, end);
}
