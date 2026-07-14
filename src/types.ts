/** Shared types for the pushforge public API. */

/** A browser push subscription, exactly as `PushSubscription.toJSON()` emits it. */
export interface PushSubscription {
  /** Push-service delivery URL (HTTPS, unique per subscription). */
  endpoint: string;
  keys: {
    /** UA public key: base64url of a 65-byte uncompressed P-256 point. */
    p256dh: string;
    /** 16-byte authentication secret, base64url. */
    auth: string;
  };
  expirationTime?: number | null;
}

/** A subscription at rest in the store, with pushforge bookkeeping. */
export interface StoredSubscription extends PushSubscription {
  /** Stable short id derived from the endpoint (SHA-256 prefix). */
  id: string;
  /** User-assigned routing tags, sorted and unique. */
  tags: string[];
  /** Unix milliseconds at insertion. */
  createdAt: number;
}

/** A VAPID application-server key pair, both halves base64url. */
export interface VapidKeys {
  /** 65-byte uncompressed P-256 public point — the `applicationServerKey`. */
  publicKey: string;
  /** 32-byte P-256 private scalar. */
  privateKey: string;
}

/** RFC 8030 delivery urgency. */
export type Urgency = "very-low" | "low" | "normal" | "high";

/** Per-message delivery options (all map to RFC 8030 request headers). */
export interface MessageOptions {
  /** Seconds the push service may retain the message. Default 86400. */
  ttl?: number;
  /** Delivery urgency hint. Omitted from the request when unset. */
  urgency?: Urgency;
  /** Replacement topic: <=32 base64url characters. */
  topic?: string;
}

/** A fully built push-service request, ready for any HTTP client. */
export interface PushRequest {
  endpoint: string;
  method: "POST";
  headers: Record<string, string>;
  /** RFC 8188 `aes128gcm` body (header block + single encrypted record). */
  body: Uint8Array;
}

/** What a transport reports back from the push service. */
export interface TransportResponse {
  status: number;
}

/** Pluggable HTTP layer — tests inject fakes, production uses fetch. */
export type Transport = (request: PushRequest) => Promise<TransportResponse>;

/** Terminal interpretation of a push-service response status. */
export type DeliveryOutcome = "sent" | "gone" | "retry" | "failed";

/** Private half of an EC key pair as a JWK (what pushforge persists). */
export interface EcPrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}
