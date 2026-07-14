# How Web Push fits together (and where pushforge sits)

Web Push is three RFCs that interlock. pushforge implements the
application-server side of all three — and, for offline verification, the
browser side of the encryption too.

## The three RFCs

| RFC | Name | What it defines | pushforge module |
|---|---|---|---|
| [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030) | HTTP Web Push | the request an app server POSTs to a push service: endpoint URL, `TTL`, `Urgency`, `Topic`, response codes | `sender.ts`, `queue.ts` |
| [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) | Message Encryption | end-to-end encryption of the payload so the push service (Google/Mozilla/Apple relay) cannot read it | `ece.ts`, `keys.ts` |
| [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292) | VAPID | proving to the push service which application server is sending, via an ES256 JWT | `vapid.ts` |

## The flow, end to end

1. **Keygen (once).** You generate a P-256 key pair — the *VAPID keys*. The
   public half is the `applicationServerKey` your page passes to
   `PushManager.subscribe()`; it pins every subscription to your server.
2. **Subscribe (per browser).** The browser returns a subscription:
   a unique HTTPS *endpoint* (a capability URL at the push service), a
   *p256dh* public key, and a 16-byte *auth* secret. Your backend stores it
   — with pushforge, in a plain JSON file you own.
3. **Encrypt (per message).** RFC 8291: your server makes an *ephemeral*
   ECDH key pair, agrees a shared secret with the subscription's p256dh
   key, mixes in the auth secret and a random 16-byte salt through two HKDF
   stages, and AES-128-GCM-encrypts the payload as a single RFC 8188
   `aes128gcm` record. Salt and ephemeral public key travel in the body
   header — the push service relays bytes it cannot decrypt.
4. **Authorize + POST.** RFC 8292: an ES256 JWT with `aud` = the push
   service's origin, `sub` = your contact URI, `exp` ≤ 24 h, sent as
   `Authorization: vapid t=<jwt>, k=<public key>` alongside `TTL`,
   `Urgency` and `Topic` (RFC 8030).
5. **Deliver.** The push service wakes the browser; the browser decrypts
   and fires the `push` event in your service worker. Response codes tell
   your server what happened — `201` accepted, `404`/`410` subscription
   dead (prune it), `429`/`5xx` back off and retry.

## Interop anchor

`tests/ece.test.mjs` reproduces the RFC 8291 **Appendix A** test vector
byte-for-byte — same keys, salt and plaintext, identical 144-byte body.
That vector is the cross-implementation handshake: any library that
produces it encrypts messages every browser can open.

## pushforge file formats

All state files are JSON with a versioned envelope:

```json
{ "pushforge": "<kind>", "version": 1, "data": { … } }
```

| Kind | Default file | Contents |
|---|---|---|
| `vapid` | `vapid.json` | `publicKey` (65-byte point, base64url), `privateKey` (32-byte scalar), optional `subject` |
| `subscriptions` | `subscriptions.json` | validated subscriptions with short ids, tags, timestamps |
| `queue` | `queue.json` | delivery jobs with attempt counts, backoff deadlines, last status |
| `mock-subscriber` | `ua-keys.json` | a mock browser's private JWK + auth secret (testing only) |

Writes are atomic (write-then-rename), so a crash never leaves a
half-written subscriber list. Files from other tools — or future pushforge
versions — are refused loudly instead of being misread.

## Deliberate limits in 0.1.0

- **Single-record bodies only.** Every real Web Push message is one record
  (services cap bodies at 4096 bytes); multi-record `aes128gcm` streams are
  out of scope and rejected explicitly on decrypt.
- **`aes128gcm` only.** The legacy `aesgcm`/`aesgcm128` codings (pre-2017
  drafts) are not implemented; every current browser accepts `aes128gcm`.
- **The queue is single-process.** One drain loop per queue file; there is
  no cross-process locking.
