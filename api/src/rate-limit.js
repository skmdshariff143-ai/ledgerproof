import { fail } from "./errors.js";

// Fast L1 fallback map used only if the database table is not yet created or temporarily unreachable.
const memoryBuckets = new Map();

function consumeMemoryBucket(bucketKey, maxPoints, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const current = memoryBuckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    const resetAt = now + windowMs;
    memoryBuckets.set(bucketKey, { points: 1, resetAt });
    return { allowed: true, points: 1, remaining: Math.max(0, maxPoints - 1), resetAt: new Date(resetAt) };
  }
  current.points += 1;
  return {
    allowed: current.points <= maxPoints,
    points: current.points,
    remaining: Math.max(0, maxPoints - current.points),
    resetAt: new Date(current.resetAt),
  };
}

// Consumes 1 point in PostgreSQL `rate_limit_buckets` so rate limits are enforced across all
// Vercel serverless instances without relying on process-local memory.
export async function consumeRateLimit(pool, bucketKey, { maxPoints = 300, windowSeconds = 60 } = {}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, points, reset_at)
       VALUES ($1, 1, now() + ($2 * interval '1 second'))
       ON CONFLICT (bucket_key) DO UPDATE
         SET points = CASE
               WHEN rate_limit_buckets.reset_at <= now() THEN 1
               ELSE rate_limit_buckets.points + 1
             END,
             reset_at = CASE
               WHEN rate_limit_buckets.reset_at <= now() THEN now() + ($2 * interval '1 second')
               ELSE rate_limit_buckets.reset_at
             END
       RETURNING points, reset_at`,
      [bucketKey, windowSeconds],
    );
    const { points, reset_at: resetAt } = rows[0];
    return {
      allowed: points <= maxPoints,
      points,
      remaining: Math.max(0, maxPoints - points),
      resetAt: new Date(resetAt),
      backend: "postgres",
    };
  } catch (err) {
    // Cleanly fall back to L1 memory if `rate_limit_buckets` is not yet migrated on an older schema.
    if (err.code === "42P01" || err.code === "42501") {
      return { ...consumeMemoryBucket(bucketKey, maxPoints, windowSeconds), backend: "memory" };
    }
    throw err;
  }
}

export async function checkRateLimiterHealth(pool) {
  try {
    await pool.query("SELECT 1 FROM rate_limit_buckets LIMIT 1");
    return { status: "ready", backend: "postgres" };
  } catch (err) {
    if (err.code === "42P01" || err.code === "42501") {
      return { status: "degraded", backend: "memory_fallback" };
    }
    throw err;
  }
}

export function rateLimitMiddleware(pool, { prefix = "api", maxPoints = 300, windowSeconds = 60 } = {}) {
  return async (req, res, next) => {
    const key = `${prefix}:${req.ip || "local"}`;
    const status = await consumeRateLimit(pool, key, { maxPoints, windowSeconds });
    res.set("X-RateLimit-Limit", String(maxPoints));
    res.set("X-RateLimit-Remaining", String(status.remaining));
    if (!status.allowed) {
      throw fail("RATE_LIMITED", "too many requests, please retry after window resets");
    }
    next();
  };
}
