/**
 * Base64url (RFC 4648 §5) codec, implemented in-repo so pushforge has zero
 * runtime dependencies and no reliance on Node's `Buffer`. Web Push is
 * base64url end to end: subscription keys, VAPID tokens, JWT segments.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REVERSE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Encode bytes as unpadded base64url. */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Decode base64url text to bytes. Trailing `=` padding is tolerated (some
 * browsers emit padded subscription keys); any other character outside the
 * base64url alphabet is rejected loudly rather than silently skipped.
 */
export function b64urlDecode(text: string): Uint8Array {
  const trimmed = text.replace(/=+$/, "");
  const rem = trimmed.length % 4;
  if (rem === 1) throw new Error(`invalid base64url length: ${text.length}`);
  const outLen = Math.floor((trimmed.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    const value = code < 128 ? (REVERSE[code] as number) : -1;
    if (value < 0) throw new Error(`invalid base64url character: ${JSON.stringify(trimmed[i])}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** UTF-8 encode a string. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 decode bytes (throws on malformed sequences). */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
