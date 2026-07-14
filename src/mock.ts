/**
 * A mock browser subscriber: generates the exact key material a real
 * `PushManager.subscribe()` call would (UA ECDH pair + 16-byte auth secret)
 * plus a fake endpoint. Paired with `decrypt`, this lets the entire pipeline
 * — keygen → store → encrypt → deliver → decrypt — be exercised end to end
 * with no browser and no network, which is how pushforge tests itself.
 */

import { b64urlEncode } from "./b64url.js";
import { AUTH_SECRET_LENGTH, generateEcdhPair, randomBytes } from "./keys.js";
import type { EcPrivateJwk, PushSubscription } from "./types.js";

/** The private half a real browser would keep internal. */
export interface MockSubscriberSecrets {
  /** UA ECDH private key (JWK) — what `pushforge decrypt` consumes. */
  privateJwk: EcPrivateJwk;
  /** Auth secret, base64url (same value as subscription.keys.auth). */
  auth: string;
}

export interface MockSubscriber {
  subscription: PushSubscription;
  secrets: MockSubscriberSecrets;
}

/**
 * Create a mock subscriber. The endpoint defaults to a unique capability
 * URL under `https://push.example.test`, mimicking real push services.
 */
export async function createMockSubscriber(endpoint?: string): Promise<MockSubscriber> {
  const ua = await generateEcdhPair();
  const auth = b64urlEncode(randomBytes(AUTH_SECRET_LENGTH));
  const resolvedEndpoint = endpoint ?? `https://push.example.test/send/${b64urlEncode(randomBytes(24))}`;
  return {
    subscription: {
      endpoint: resolvedEndpoint,
      keys: { p256dh: b64urlEncode(ua.publicRaw), auth },
    },
    secrets: { privateJwk: ua.privateJwk, auth },
  };
}
