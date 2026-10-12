/**
 * In-memory token buckets, one per key: `perMinute` requests, refilled
 * continuously. Per pod (with 2 replicas the effective limit doubles; good
 * enough to stop brute force and accidents, not a quota system).
 * perMinute <= 0 disables the limit.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** true = allowed (one token taken), false = over the limit. */
  take(key: string): boolean {
    if (this.perMinute <= 0) {
      return true;
    }

    const now = this.now();
    const bucket = this.refilled(key, now);

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);

    if (this.buckets.size > this.maxKeys) {
      this.prune(now);
    }

    return true;
  }

  /** Number of keys tracked (tests). */
  get size(): number {
    return this.buckets.size;
  }

  private refilled(key: string, now: number): { tokens: number; at: number } {
    const bucket = this.buckets.get(key);

    if (!bucket) {
      return { tokens: this.perMinute, at: now };
    }

    const refill = ((now - bucket.at) * this.perMinute) / 60_000;

    return {
      tokens: Math.min(this.perMinute, bucket.tokens + refill),
      at: now,
    };
  }

  /** Forgets full buckets (= keys idle long enough); worst case all. */
  private prune(now: number): void {
    for (const key of [...this.buckets.keys()]) {
      if (this.refilled(key, now).tokens >= this.perMinute) {
        this.buckets.delete(key);
      }
    }

    if (this.buckets.size > this.maxKeys) {
      this.buckets.clear();
    }
  }
}
