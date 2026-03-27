/**
 * Rate limiter — KV-backed fixed window, distributed across Deploy isolates.
 *
 * Uses Deno.Kv atomic sum for lock-free counting + expireIn for auto-cleanup.
 * No external library needed.
 */

import { log } from "../shared/log.ts";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export class RateLimiter {
  private kv: Deno.Kv;
  private limit: number;
  private windowMs: number;

  constructor(kv: Deno.Kv, limit: number, windowMs: number) {
    this.kv = kv;
    this.limit = limit;
    this.windowMs = windowMs;
  }

  async check(identifier: string): Promise<RateLimitResult> {
    const windowStart = Math.floor(Date.now() / this.windowMs) * this.windowMs;
    const key: Deno.KvKey = ["rl", identifier, windowStart];

    const entry = await this.kv.get<Deno.KvU64>(key);

    // First request in this window: create counter with TTL
    if (entry.value === null) {
      const res = await this.kv.atomic()
        .check({ key, versionstamp: null })
        .set(key, new Deno.KvU64(1n), { expireIn: this.windowMs * 2 })
        .commit();

      if (res.ok) {
        return {
          allowed: true,
          remaining: this.limit - 1,
          retryAfterSec: 0,
        };
      }
      // Lost the race — fall through to increment
    }

    // Increment atomically
    await this.kv.atomic().sum(key, 1n).commit();

    const current = entry.value ? Number(entry.value.value) + 1 : 1;
    const resetMs = windowStart + this.windowMs;
    const retryAfterSec = Math.max(
      0,
      Math.ceil((resetMs - Date.now()) / 1000),
    );

    if (current > this.limit) {
      log.warn(
        `Rate limit exceeded for ${identifier} (${current}/${this.limit})`,
      );
    }

    return {
      allowed: current <= this.limit,
      remaining: Math.max(0, this.limit - current),
      retryAfterSec,
    };
  }

  /** Build a 429 structured response. */
  denyResponse(result: RateLimitResult): Response {
    return new Response(
      JSON.stringify({
        code: "RATE_LIMIT_EXCEEDED",
        context: { retryAfterSec: result.retryAfterSec },
        recovery: `Wait ${result.retryAfterSec}s and retry`,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(result.retryAfterSec),
          "X-RateLimit-Remaining": String(result.remaining),
        },
      },
    );
  }
}
