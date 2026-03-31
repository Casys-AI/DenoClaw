import { assertEquals, assertStrictEquals } from "@std/assert";
import { GitHubOAuth, SESSION_COOKIE } from "./github_oauth.ts";

// ── SESSION_COOKIE export ──────────────────────────────────

Deno.test({
  name: "SESSION_COOKIE — is the expected cookie name",
  fn() {
    assertEquals(SESSION_COOKIE, "denoclaw_session");
  },
});

// ── GitHubOAuth.verifySession ──────────────────────────────

Deno.test({
  name: "GitHubOAuth.verifySession — returns null when no cookie header",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const oauth = new GitHubOAuth(kv);

    const req = new Request("http://localhost/dashboard");
    const user = await oauth.verifySession(req);
    assertStrictEquals(user, null);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "GitHubOAuth.verifySession — returns null when cookie does not contain session cookie",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const oauth = new GitHubOAuth(kv);

    const req = new Request("http://localhost/dashboard", {
      headers: { cookie: "other_cookie=abc123" },
    });
    const user = await oauth.verifySession(req);
    assertStrictEquals(user, null);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "GitHubOAuth.verifySession — returns null for unknown session id",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const oauth = new GitHubOAuth(kv);

    const req = new Request("http://localhost/dashboard", {
      headers: { cookie: `${SESSION_COOKIE}=nonexistent-session-id` },
    });
    const user = await oauth.verifySession(req);
    assertStrictEquals(user, null);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "GitHubOAuth.verifySession — returns user for valid session in KV",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const oauth = new GitHubOAuth(kv);

    const sessionId = crypto.randomUUID();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await kv.set(["dashboard", "session", sessionId], {
      user: { login: "alice", id: 42, avatar_url: "https://example.com/a.png" },
      createdAt: new Date().toISOString(),
      expiresAt: future.toISOString(),
    });

    const req = new Request("http://localhost/dashboard", {
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    const user = await oauth.verifySession(req);
    assertEquals(user?.login, "alice");
    assertEquals(user?.id, 42);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "GitHubOAuth.verifySession — returns null and clears expired session",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const oauth = new GitHubOAuth(kv);

    const sessionId = crypto.randomUUID();
    const past = new Date(Date.now() - 1000); // already expired
    await kv.set(["dashboard", "session", sessionId], {
      user: { login: "bob", id: 7, avatar_url: "" },
      createdAt: new Date(Date.now() - 2000).toISOString(),
      expiresAt: past.toISOString(),
    });

    const req = new Request("http://localhost/dashboard", {
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    const user = await oauth.verifySession(req);
    assertStrictEquals(user, null);

    // Session should have been deleted
    const entry = await kv.get(["dashboard", "session", sessionId]);
    assertStrictEquals(entry.value, null);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "GitHubOAuth.verifySession — handles multiple cookies, extracts correct one",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const oauth = new GitHubOAuth(kv);

    const sessionId = crypto.randomUUID();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await kv.set(["dashboard", "session", sessionId], {
      user: { login: "carol", id: 99, avatar_url: "" },
      createdAt: new Date().toISOString(),
      expiresAt: future.toISOString(),
    });

    const req = new Request("http://localhost/dashboard", {
      headers: {
        cookie: `other=xyz; ${SESSION_COOKIE}=${sessionId}; another=abc`,
      },
    });
    const user = await oauth.verifySession(req);
    assertEquals(user?.login, "carol");

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── GitHubOAuth.isConfigured ───────────────────────────────

Deno.test({
  name: "GitHubOAuth.isConfigured — false when env vars not set",
  fn() {
    const prevId = Deno.env.get("GITHUB_CLIENT_ID");
    const prevSecret = Deno.env.get("GITHUB_CLIENT_SECRET");
    Deno.env.delete("GITHUB_CLIENT_ID");
    Deno.env.delete("GITHUB_CLIENT_SECRET");

    // We can't open KV synchronously, use a minimal stub
    const oauth = new GitHubOAuth(null as unknown as Deno.Kv);
    assertEquals(oauth.isConfigured(), false);

    if (prevId) Deno.env.set("GITHUB_CLIENT_ID", prevId);
    if (prevSecret) Deno.env.set("GITHUB_CLIENT_SECRET", prevSecret);
  },
});

Deno.test({
  name: "GitHubOAuth.isConfigured — true when both env vars set",
  fn() {
    const prevId = Deno.env.get("GITHUB_CLIENT_ID");
    const prevSecret = Deno.env.get("GITHUB_CLIENT_SECRET");
    Deno.env.set("GITHUB_CLIENT_ID", "test-id");
    Deno.env.set("GITHUB_CLIENT_SECRET", "test-secret");

    const oauth = new GitHubOAuth(null as unknown as Deno.Kv);
    assertEquals(oauth.isConfigured(), true);

    if (prevId) Deno.env.set("GITHUB_CLIENT_ID", prevId);
    else Deno.env.delete("GITHUB_CLIENT_ID");
    if (prevSecret) Deno.env.set("GITHUB_CLIENT_SECRET", prevSecret);
    else Deno.env.delete("GITHUB_CLIENT_SECRET");
  },
});
