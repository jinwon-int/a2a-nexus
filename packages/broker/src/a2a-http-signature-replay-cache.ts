// A2A HTTP-signature replay cache, extracted from server.ts. Remembers
// (keyid, nonce) pairs until their signature expiry so a replayed signed worker
// request is rejected exactly once within its validity window. Bounded by a max
// entry count (oldest-first eviction). Self-contained: holds only its own Map.

const A2A_HTTP_SIGNATURE_REPLAY_CACHE_MAX_ENTRIES = 10_000;
// #2079 C: full-map expiry pruning used to run on every remember() — an
// O(10k) scan per signed request. Expired entries are reclaimed at most once
// per window instead; correctness is unaffected because the duplicate check
// reads the stored expiry directly.
const A2A_HTTP_SIGNATURE_REPLAY_CACHE_PRUNE_INTERVAL_SECONDS = 60;

export class A2AHttpSignatureReplayCache {
  private readonly entries = new Map<string, number>();
  private nextPruneAtEpochSeconds = 0;

  remember(keyid: string, nonce: string, expiresEpochSeconds: number, nowEpochSeconds = Math.floor(Date.now() / 1000)): boolean {
    if (nowEpochSeconds >= this.nextPruneAtEpochSeconds) {
      this.nextPruneAtEpochSeconds = nowEpochSeconds + A2A_HTTP_SIGNATURE_REPLAY_CACHE_PRUNE_INTERVAL_SECONDS;
      this.prune(nowEpochSeconds);
    }
    const cacheKey = `${keyid}\0${nonce}`;
    const existingExpires = this.entries.get(cacheKey);
    if (existingExpires !== undefined && existingExpires > nowEpochSeconds) {
      return false;
    }
    this.entries.set(cacheKey, expiresEpochSeconds);
    while (this.entries.size > A2A_HTTP_SIGNATURE_REPLAY_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(nowEpochSeconds: number): void {
    for (const [key, expires] of this.entries) {
      if (expires <= nowEpochSeconds) {
        this.entries.delete(key);
      }
    }
  }
}
