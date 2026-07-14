/**
 * pushforge — self-hosted Web Push, end to end: VAPID keys, RFC 8291
 * encryption, a subscription store and a retrying delivery queue, built on
 * Node's webcrypto with zero runtime dependencies.
 */

export { b64urlDecode, b64urlEncode } from "./b64url.js";
export {
  DEFAULT_RECORD_SIZE,
  HEADER_LENGTH,
  decrypt,
  encrypt,
  maxPlaintextLength,
  parseHeader,
  type EceHeader,
  type EncryptOptions,
} from "./ece.js";
export {
  AUTH_SECRET_LENGTH,
  PRIVATE_KEY_LENGTH,
  PUBLIC_KEY_LENGTH,
  generateEcdhPair,
  generateVapidKeys,
  vapidPrivateJwk,
} from "./keys.js";
export { createMockSubscriber, type MockSubscriber, type MockSubscriberSecrets } from "./mock.js";
export {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  DEFAULT_MAX_ATTEMPTS,
  DeliveryQueue,
  backoffMs,
  type DrainOptions,
  type DrainReport,
  type JobStatus,
  type QueueJob,
} from "./queue.js";
export {
  DEFAULT_TTL_SECONDS,
  MAX_BODY_LENGTH,
  buildPushRequest,
  classifyStatus,
  fetchTransport,
  sendNotification,
  validateTopic,
  validateTtl,
  validateUrgency,
  type BuildOptions,
  type SendResult,
} from "./sender.js";
export { SubscriptionStore, type AddResult } from "./store.js";
export { subscriptionId, validateSubscription, validateTag } from "./subscription.js";
export type {
  DeliveryOutcome,
  EcPrivateJwk,
  MessageOptions,
  PushRequest,
  PushSubscription,
  StoredSubscription,
  Transport,
  TransportResponse,
  Urgency,
  VapidKeys,
} from "./types.js";
export {
  DEFAULT_EXPIRATION_SECONDS,
  MAX_EXPIRATION_SECONDS,
  audienceFromEndpoint,
  buildVapidAuthorization,
  signJwt,
  validateSubject,
  verifyJwt,
  type VapidOptions,
} from "./vapid.js";
export { VERSION } from "./version.js";
