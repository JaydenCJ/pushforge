/**
 * RFC 8292 (VAPID) — voluntary application server identification. Each push
 * request carries an ES256 JWT scoped to the push service's origin plus the
 * server's public key, in a single `Authorization: vapid t=…, k=…` header.
 * Signing uses WebCrypto ECDSA, which conveniently emits the raw r||s form
 * JWS wants — no DER wrangling.
 */

import { b64urlDecode, b64urlEncode, utf8, utf8Decode } from "./b64url.js";
import { importVapidSigningKey, importVapidVerifyKey } from "./keys.js";
import type { VapidKeys } from "./types.js";

/** RFC 8292 caps token lifetime at 24 hours. */
export const MAX_EXPIRATION_SECONDS = 24 * 60 * 60;
/** Default token lifetime: 12 hours, half the allowed maximum. */
export const DEFAULT_EXPIRATION_SECONDS = 12 * 60 * 60;

export interface VapidOptions {
  keys: VapidKeys;
  /** Contact URI for the push service operator: `mailto:` or `https:`. */
  subject: string;
  /** Token lifetime in seconds (1 .. 86400). Default 43200. */
  expirationSeconds?: number;
  /** Clock override for deterministic tests, Unix milliseconds. */
  now?: number;
}

/** Derive the JWT audience (push service origin) from an endpoint URL. */
export function audienceFromEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`invalid endpoint URL: ${JSON.stringify(endpoint)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`endpoint must be https (RFC 8030), got ${url.protocol}//${url.host}`);
  }
  return url.origin;
}

/** Validate the VAPID subject claim (RFC 8292 §2.1). */
export function validateSubject(subject: string): string {
  if (subject.startsWith("mailto:") && subject.length > "mailto:".length) return subject;
  if (subject.startsWith("https://")) {
    audienceFromEndpoint(subject); // reuse URL validation
    return subject;
  }
  throw new Error(`invalid VAPID subject ${JSON.stringify(subject)}: must be a mailto: or https: URI`);
}

/** Sign a compact ES256 JWT over the given claims. */
export async function signJwt(claims: Record<string, string | number>, keys: VapidKeys): Promise<string> {
  const header = b64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(utf8(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await importVapidSigningKey(keys);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  return `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;
}

/** Decode + verify an ES256 JWT against a base64url public key. */
export async function verifyJwt(
  token: string,
  publicKey: string,
): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error(`malformed JWT: ${parts.length} segments (want 3)`);
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const key = await importVapidVerifyKey(publicKey);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlDecode(signaturePart),
    utf8(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("JWT signature verification failed");
  return {
    header: JSON.parse(utf8Decode(b64urlDecode(headerPart))) as Record<string, unknown>,
    payload: JSON.parse(utf8Decode(b64urlDecode(payloadPart))) as Record<string, unknown>,
  };
}

/**
 * Build the `Authorization` header value for one push request:
 * `vapid t=<jwt>, k=<public key>`.
 */
export async function buildVapidAuthorization(endpoint: string, options: VapidOptions): Promise<string> {
  const aud = audienceFromEndpoint(endpoint);
  const sub = validateSubject(options.subject);
  const lifetime = options.expirationSeconds ?? DEFAULT_EXPIRATION_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_EXPIRATION_SECONDS) {
    throw new Error(`invalid VAPID expiration ${lifetime}s: must be 1..${MAX_EXPIRATION_SECONDS} (RFC 8292 caps at 24h)`);
  }
  const nowMs = options.now ?? Date.now();
  const exp = Math.floor(nowMs / 1000) + lifetime;
  const token = await signJwt({ aud, exp, sub }, options.keys);
  return `vapid t=${token}, k=${options.keys.publicKey}`;
}
