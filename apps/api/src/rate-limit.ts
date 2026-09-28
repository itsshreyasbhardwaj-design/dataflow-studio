import { ApiError } from "./errors.js";

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule, now?: number): Promise<RateLimitResult>;
}

/**
 * Sliding-window limiter held in process memory.
 *
 * Correct for a single API instance and for development. A multi-instance
 * deployment should point `REDIS_URL` at a shared Redis and use
 * {@link RedisRateLimiter}, because per-instance counters multiply the effective
 * limit by the number of instances.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  async consume(key: string, rule: RateLimitRule, now = Date.now()): Promise<RateLimitResult> {
    const windowMs = rule.windowSeconds * 1000;
    const cutoff = now - windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= rule.limit) {
      const oldest = timestamps[0]!;
      const resetAt = oldest + windowMs;
      this.hits.set(key, timestamps);
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);

    // Opportunistic cleanup so an idle process does not grow without bound.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (!v.some((t) => t > cutoff)) this.hits.delete(k);
      }
    }
    return {
      allowed: true,
      remaining: rule.limit - timestamps.length,
      resetAt: now + windowMs,
      retryAfterSeconds: 0,
    };
  }

  reset(): void {
    this.hits.clear();
  }
}

export interface RedisLike {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/** Shared-state limiter for multi-instance deployments. */
export class RedisRateLimiter implements RateLimiter {
  private static readonly SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

  constructor(private readonly redis: RedisLike) {}

  async consume(key: string, rule: RateLimitRule, now = Date.now()): Promise<RateLimitResult> {
    const windowMs = rule.windowSeconds * 1000;
    const bucket = `ratelimit:${key}:${Math.floor(now / windowMs)}`;
    const [current, ttl] = (await this.redis.eval(RedisRateLimiter.SCRIPT, [bucket], [String(rule.limit), String(windowMs)])) as [number, number];
    const allowed = current <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - current),
      resetAt: now + Math.max(0, ttl),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Math.max(0, ttl) / 1000)),
    };
  }
}

export const RATE_LIMITS = {
  /** Everything, per principal. */
  default: { limit: 600, windowSeconds: 60 },
  /** Starting runs is the expensive one. */
  execute: { limit: 60, windowSeconds: 60 },
  /** Unauthenticated probes, per IP. */
  anonymous: { limit: 30, windowSeconds: 60 },
  /** Writes that create rows. */
  write: { limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  rule: RateLimitRule,
  now?: number,
): Promise<RateLimitResult> {
  const result = await limiter.consume(key, rule, now);
  if (!result.allowed) throw ApiError.rateLimited(result.retryAfterSeconds);
  return result;
}
