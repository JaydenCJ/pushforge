/**
 * Turning (subscription, payload, options) into one RFC 8030 push-service
 * request: encrypted body, `aes128gcm` content coding, TTL/Urgency/Topic
 * headers and the VAPID authorization. The HTTP layer itself is a pluggable
 * `Transport`, so every test runs offline and production uses `fetch`.
 */

import { b64urlDecode, utf8 } from "./b64url.js";
import { encrypt, type EncryptOptions } from "./ece.js";
import { validateSubscription } from "./subscription.js";
import type {
  DeliveryOutcome,
  MessageOptions,
  PushRequest,
  PushSubscription,
  Transport,
  TransportResponse,
  Urgency,
} from "./types.js";
import { buildVapidAuthorization, type VapidOptions } from "./vapid.js";

/** Push services reject bodies over 4096 bytes (RFC 8030 guidance). */
export const MAX_BODY_LENGTH = 4096;
/** Default TTL: one day. Long enough to survive an offline phone overnight. */
export const DEFAULT_TTL_SECONDS = 86400;

const URGENCIES: readonly Urgency[] = ["very-low", "low", "normal", "high"];

export interface BuildOptions extends MessageOptions {
  vapid: VapidOptions;
  /** Advanced: fixed salt / AS keys / padding, forwarded to the encryptor. */
  encryption?: EncryptOptions;
}

/** Validate a TTL value (seconds the push service may hold the message). */
export function validateTtl(ttl: number): number {
  if (!Number.isInteger(ttl) || ttl < 0) {
    throw new Error(`invalid TTL ${ttl}: must be a non-negative integer number of seconds`);
  }
  return ttl;
}

/** Validate an RFC 8030 Topic header value. */
export function validateTopic(topic: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(topic)) {
    throw new Error(`invalid topic ${JSON.stringify(topic)}: must be 1-32 base64url characters (RFC 8030 §5.4)`);
  }
  return topic;
}

/** Validate an urgency value. */
export function validateUrgency(urgency: string): Urgency {
  if (!(URGENCIES as readonly string[]).includes(urgency)) {
    throw new Error(`invalid urgency ${JSON.stringify(urgency)}: must be one of ${URGENCIES.join(", ")}`);
  }
  return urgency as Urgency;
}

/**
 * Build the complete push-service request for one subscription. Pure with
 * respect to I/O: nothing is sent, no file is touched.
 */
export async function buildPushRequest(
  subscription: PushSubscription,
  payload: Uint8Array | string,
  options: BuildOptions,
): Promise<PushRequest> {
  const sub = validateSubscription(subscription);
  const plaintext = typeof payload === "string" ? utf8(payload) : payload;
  if (plaintext.length === 0) {
    throw new Error("payload must not be empty (send at least one byte for the service worker to display)");
  }

  const body = await encrypt(plaintext, b64urlDecode(sub.keys.p256dh), b64urlDecode(sub.keys.auth), options.encryption);
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(`encrypted body is ${body.length} bytes; push services cap requests at ${MAX_BODY_LENGTH}`);
  }

  const headers: Record<string, string> = {
    Authorization: await buildVapidAuthorization(sub.endpoint, options.vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(body.length),
    TTL: String(validateTtl(options.ttl ?? DEFAULT_TTL_SECONDS)),
  };
  if (options.urgency !== undefined) headers.Urgency = validateUrgency(options.urgency);
  if (options.topic !== undefined) headers.Topic = validateTopic(options.topic);

  return { endpoint: sub.endpoint, method: "POST", headers, body };
}

/**
 * Interpret a push-service response status:
 * - 2xx        → sent (201 is the canonical accept, some services use 200/202)
 * - 404 / 410  → gone: the subscription is dead, prune it
 * - 429 / 5xx  → retry: transient, back off and try again
 * - anything else → failed: a request bug (auth, size, format), retrying won't help
 */
export function classifyStatus(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || (status >= 500 && status < 600)) return "retry";
  return "failed";
}

/** The production transport: POST via global fetch. */
export const fetchTransport: Transport = async (request: PushRequest): Promise<TransportResponse> => {
  const response = await fetch(request.endpoint, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  return { status: response.status };
};

export interface SendResult {
  status: number;
  outcome: DeliveryOutcome;
}

/** Build and deliver one notification through the given transport. */
export async function sendNotification(
  subscription: PushSubscription,
  payload: Uint8Array | string,
  options: BuildOptions,
  transport: Transport = fetchTransport,
): Promise<SendResult> {
  const request = await buildPushRequest(subscription, payload, options);
  const response = await transport(request);
  return { status: response.status, outcome: classifyStatus(response.status) };
}
