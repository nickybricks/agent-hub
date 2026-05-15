export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

// --- in-memory token bucket (used when UPSTASH_REDIS_REST_URL is not set) ---

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

function checkInMemory(key: string, limit: number, windowSeconds: number): RateLimitResult {
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

// --- Upstash sliding-window (used in production when env vars are set) ---

async function checkUpstash(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const { Ratelimit } = await import("@upstash/ratelimit");
  const { Redis } = await import("@upstash/redis");

  const ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
  });

  const { success, reset } = await ratelimit.limit(key);
  const retryAfterSeconds = success ? 0 : Math.ceil((reset - Date.now()) / 1000);
  return { ok: success, retryAfterSeconds: Math.max(0, retryAfterSeconds) };
}

// --- public interface ---

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    return checkUpstash(key, limit, windowSeconds);
  }
  return checkInMemory(key, limit, windowSeconds);
}

export function ipFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
