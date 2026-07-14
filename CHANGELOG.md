# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- RFC 8291 message encryption (`aes128gcm`, single record) on Node's
  WebCrypto: ECDH over P-256, two-stage HKDF keyed by the subscription's
  auth secret, AES-128-GCM — verified byte-for-byte against the RFC 8291
  Appendix A test vector. Decryption (the browser side) is implemented too,
  so the whole pipeline is verifiable offline.
- RFC 8292 VAPID: ES256 JWT signing and verification, audience derivation
  from the endpoint origin, subject validation, the 24-hour expiration cap,
  and the `Authorization: vapid t=…, k=…` header builder.
- `pushforge keygen`: P-256 application-server key pairs written to a
  versioned JSON file, with the `applicationServerKey` printed for the
  browser and overwrite protection.
- Subscription store: a plain JSON file with validation at the trust
  boundary (https endpoint, 65-byte p256dh point, 16-byte auth secret),
  endpoint-hash short ids, idempotent re-adds with tag merging, tag
  filtering, and atomic write-then-rename persistence.
- Delivery queue: one job per (message, subscription), injected clock and
  transport, exponential backoff (30s -> 2m -> 8m -> 32m, capped at 1h),
  status classification per the push-service contract (2xx sent, 404/410
  gone with automatic store pruning, 429/5xx retried, other 4xx failed),
  and crash-safe JSON persistence.
- Request builder emitting the full RFC 8030 header set (`TTL`, `Urgency`,
  `Topic`, `Content-Encoding: aes128gcm`) with validation of every value
  and the 4096-byte body cap.
- Mock subscriber (`pushforge mock`): generates the exact key material a
  real `PushManager.subscribe()` call would, enabling the offline
  keygen -> add -> send -> decrypt round-trip used by the smoke test.
- CLI: `keygen`, `mock`, `add`, `list`, `remove`, `send` (with `--dry-run`
  and on-disk request capture), `enqueue`, `drain`, `queue-status`,
  `decrypt`; exit codes distinguish usage errors (2) from refused
  operations (1); private keys never appear in listings or logs.
- Public programmatic API (`buildPushRequest`, `sendNotification`,
  `encrypt`/`decrypt`, `SubscriptionStore`, `DeliveryQueue`, VAPID and
  base64url helpers) with full type declarations.
- Browser-side examples (page subscription + service worker) and an
  offline server-side API example with an injected transport.
- Test suite: 90 node:test tests (unit + CLI integration in fresh temp
  dirs, zero network, zero sleeps) and an end-to-end `scripts/smoke.sh`.

[0.1.0]: https://github.com/JaydenCJ/pushforge/releases/tag/v0.1.0
