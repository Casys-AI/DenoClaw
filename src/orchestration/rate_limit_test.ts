import { assertEquals, assertStrictEquals } from "@std/assert";
import { RateLimiter } from "./rate_limit.ts";

// ── check — first request in window ───────────────────────

Deno.test({
  name: "RateLimiter.check — first request is allowed",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const limiter = new RateLimiter(kv, 5, 60_000);

    const result = await limiter.check("user-1");
    assertStrictEquals(result.allowed, true);
    assertEquals(result.remaining, 4);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "RateLimiter.check — remaining decrements with each call",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const limiter = new RateLimiter(kv, 3, 60_000);

    const r1 = await limiter.check("user-dec");
    assertStrictEquals(r1.allowed, true);

    // subsequent calls increment the counter via atomic sum
    const r2 = await limiter.check("user-dec");
    assertStrictEquals(r2.allowed, true);

    const r3 = await limiter.check("user-dec");
    assertStrictEquals(r3.allowed, true);

    // 4th call exceeds limit=3
    const r4 = await limiter.check("user-dec");
    assertStrictEquals(r4.allowed, false);
    assertEquals(r4.remaining, 0);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "RateLimiter.check — limit exceeded returns allowed=false",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const limiter = new RateLimiter(kv, 2, 60_000);

    // exhaust the 2-request limit
    await limiter.check("user-x");
    await limiter.check("user-x");
    // 3rd call — over limit
    const result = await limiter.check("user-x");
    assertStrictEquals(result.allowed, false);
    assertEquals(result.remaining, 0);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "RateLimiter.check — different identifiers have independent windows",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const limiter = new RateLimiter(kv, 1, 60_000);

    // exhaust limit for user-a
    await limiter.check("user-a");
    const blocked = await limiter.check("user-a");
    assertStrictEquals(blocked.allowed, false);

    // user-b is untouched
    const fresh = await limiter.check("user-b");
    assertStrictEquals(fresh.allowed, true);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "RateLimiter.check — retryAfterSec is non-negative",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const limiter = new RateLimiter(kv, 1, 60_000);

    await limiter.check("user-retry");
    const result = await limiter.check("user-retry");
    assertEquals(result.retryAfterSec >= 0, true);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── denyResponse ───────────────────────────────────────────

Deno.test({
  name: "RateLimiter.denyResponse — returns 429 with correct headers and body",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const limiter = new RateLimiter(kv, 5, 60_000);

    const res = limiter.denyResponse({
      allowed: false,
      remaining: 0,
      retryAfterSec: 42,
    });

    assertEquals(res.status, 429);
    assertEquals(res.headers.get("Content-Type"), "application/json");
    assertEquals(res.headers.get("Retry-After"), "42");
    assertEquals(res.headers.get("X-RateLimit-Remaining"), "0");

    const body = await res.json() as {
      code: string;
      context: { retryAfterSec: number };
      recovery: string;
    };
    assertEquals(body.code, "RATE_LIMIT_EXCEEDED");
    assertEquals(body.context.retryAfterSec, 42);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "RateLimiter.denyResponse — recovery message contains retryAfterSec",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const limiter = new RateLimiter(kv, 5, 60_000);

    const res = limiter.denyResponse({
      allowed: false,
      remaining: 0,
      retryAfterSec: 10,
    });

    const body = await res.json() as { recovery: string };
    assertEquals(body.recovery.includes("10"), true);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
