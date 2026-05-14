/**
 * In-process token-bucket rate limiter.
 *
 * Single-tenant only — state lives in module memory and dies with the process.
 * Designed to be swapped for an Upstash-backed implementation in Phase 6
 * without changing the call sites: keep the function signature stable.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): RateLimitResult {
  const now = Date.now();
  const refillPerMs = limit / (windowSeconds * 1000);
  const bucket = buckets.get(key) ?? { tokens: limit, lastRefillMs: now };

  const elapsed = now - bucket.lastRefillMs;
  bucket.tokens = Math.min(limit, bucket.tokens + elapsed * refillPerMs);
  bucket.lastRefillMs = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { ok: true, retryAfterSeconds: 0 };
  }

  buckets.set(key, bucket);
  const tokensShort = 1 - bucket.tokens;
  const retryAfterSeconds = Math.ceil(tokensShort / refillPerMs / 1000);
  return { ok: false, retryAfterSeconds };
}

export function ipFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
