// Shared PEM → KeyObject memoization for the signing/verify hot paths.
// createPrivateKey/createPublicKey re-parse the same fixed PEMs (the broker's
// signing key, registered keyring entries) on every call; the sets are tiny and
// static, so cache the parsed KeyObject per PEM string in a small bounded Map
// with insertion-order eviction. Parse failures are never cached — they
// propagate to the caller exactly as an uncached parse would.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

const MAX_CACHED_KEYS = 64;

function cachedKey(cache: Map<string, KeyObject>, pem: string, parse: (pem: string) => KeyObject): KeyObject {
  const hit = cache.get(pem);
  if (hit) return hit;
  const key = parse(pem);
  if (cache.size >= MAX_CACHED_KEYS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(pem, key);
  return key;
}

const publicKeys = new Map<string, KeyObject>();
const privateKeys = new Map<string, KeyObject>();

/** createPublicKey(pem), memoized per PEM string. */
export function cachedPublicKey(pem: string): KeyObject {
  return cachedKey(publicKeys, pem, createPublicKey);
}

/** createPrivateKey(pem), memoized per PEM string. */
export function cachedPrivateKey(pem: string): KeyObject {
  return cachedKey(privateKeys, pem, createPrivateKey);
}
