/**
 * Validation and identity for browser push subscriptions. A subscription is
 * untrusted input (it arrives from a client HTTP request), so everything is
 * checked structurally *and* cryptographically-shaped before it is stored:
 * endpoint scheme, key point format, auth secret length.
 */

import { b64urlDecode, b64urlEncode, utf8 } from "./b64url.js";
import { AUTH_SECRET_LENGTH, assertRawPublicKey } from "./keys.js";
import type { PushSubscription } from "./types.js";

/** Length of the short subscription id (hex characters of a SHA-256 prefix). */
export const ID_LENGTH = 12;

/**
 * Validate an untrusted value as a push subscription. Returns a normalized
 * copy (only the fields pushforge uses) or throws with a precise reason.
 */
export function validateSubscription(value: unknown): PushSubscription {
  if (typeof value !== "object" || value === null) {
    throw new Error("subscription must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.endpoint !== "string" || record.endpoint === "") {
    throw new Error("subscription.endpoint must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(record.endpoint);
  } catch {
    throw new Error(`subscription.endpoint is not a valid URL: ${JSON.stringify(record.endpoint)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`subscription.endpoint must be https, got ${url.protocol}`);
  }
  const keys = record.keys;
  if (typeof keys !== "object" || keys === null) {
    throw new Error("subscription.keys must be an object with p256dh and auth");
  }
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string") throw new Error("subscription.keys.p256dh must be a string");
  if (typeof auth !== "string") throw new Error("subscription.keys.auth must be a string");
  let p256dhBytes: Uint8Array;
  let authBytes: Uint8Array;
  try {
    p256dhBytes = b64urlDecode(p256dh);
  } catch (err) {
    throw new Error(`subscription.keys.p256dh is not base64url: ${(err as Error).message}`);
  }
  try {
    authBytes = b64urlDecode(auth);
  } catch (err) {
    throw new Error(`subscription.keys.auth is not base64url: ${(err as Error).message}`);
  }
  try {
    assertRawPublicKey(p256dhBytes);
  } catch (err) {
    throw new Error(`subscription.keys.p256dh: ${(err as Error).message}`);
  }
  if (authBytes.length !== AUTH_SECRET_LENGTH) {
    throw new Error(`subscription.keys.auth must decode to ${AUTH_SECRET_LENGTH} bytes, got ${authBytes.length}`);
  }
  const normalized: PushSubscription = {
    endpoint: record.endpoint,
    keys: { p256dh: b64urlEncode(p256dhBytes), auth: b64urlEncode(authBytes) },
  };
  if (typeof record.expirationTime === "number" || record.expirationTime === null) {
    normalized.expirationTime = record.expirationTime;
  }
  return normalized;
}

/**
 * Stable short id for a subscription: the first 12 hex characters of
 * SHA-256(endpoint). Endpoints are unique per subscription, so this is a
 * safe key that avoids echoing capability URLs into logs and CLI output.
 */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(endpoint)));
  let hex = "";
  for (let i = 0; i < ID_LENGTH / 2; i++) {
    hex += (digest[i] as number).toString(16).padStart(2, "0");
  }
  return hex;
}

/** Validate a routing tag: short, lowercase-ish token, no whitespace. */
export function validateTag(tag: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag)) {
    throw new Error(`invalid tag ${JSON.stringify(tag)}: use 1-64 chars of a-z 0-9 . _ - (starting alphanumeric)`);
  }
  return tag;
}
