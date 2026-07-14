/**
 * Minimal ambient declarations for the WebCrypto surface pushforge uses
 * (Node exposes `globalThis.crypto` since v19). Restricting the declared
 * surface to the calls we actually make keeps `typescript` the only
 * devDependency while preserving strict type checking.
 */

interface CryptoKey {
  readonly type: "public" | "private" | "secret";
  readonly extractable: boolean;
}

interface CryptoKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

interface EcJsonWebKey {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
  ext?: boolean;
  key_ops?: string[];
}

type EcAlgorithm = { name: "ECDSA" | "ECDH"; namedCurve: "P-256" };
type EcdhDeriveParams = { name: "ECDH"; public: CryptoKey };
type HkdfParams = { name: "HKDF"; hash: "SHA-256"; salt: Uint8Array; info: Uint8Array };
type AesGcmParams = { name: "AES-GCM"; iv: Uint8Array };
type EcdsaSignParams = { name: "ECDSA"; hash: "SHA-256" };

interface SubtleCrypto {
  generateKey(algorithm: EcAlgorithm, extractable: boolean, keyUsages: string[]): Promise<CryptoKeyPair>;
  importKey(
    format: "raw" | "jwk",
    keyData: Uint8Array | EcJsonWebKey,
    algorithm: EcAlgorithm | "HKDF" | { name: "AES-GCM" },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CryptoKey>;
  exportKey(format: "jwk", key: CryptoKey): Promise<EcJsonWebKey>;
  deriveBits(algorithm: EcdhDeriveParams | HkdfParams, baseKey: CryptoKey, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: AesGcmParams, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: AesGcmParams, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  sign(algorithm: EcdsaSignParams, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: EcdsaSignParams, key: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

declare var crypto: {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends Uint8Array>(array: T): T;
};
