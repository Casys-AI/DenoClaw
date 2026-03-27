import { assertEquals } from "@std/assert";
import { AuthManager } from "./auth.ts";

// ── Invite tokens ────────────────────────────────────────

Deno.test({
  name: "AuthManager invite token — happy path",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const invite = await auth.generateInviteToken("tunnel-a");
    assertEquals(typeof invite.token, "string");
    assertEquals(invite.tunnelId, "tunnel-a");

    const result = await auth.verifyInviteToken(invite.token);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.identity, "tunnel-a");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager invite token — double-use rejected (atomic)",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const invite = await auth.generateInviteToken();

    const first = await auth.verifyInviteToken(invite.token);
    assertEquals(first.ok, true);

    // Second use must fail
    const second = await auth.verifyInviteToken(invite.token);
    assertEquals(second.ok, false);
    if (!second.ok) {
      assertEquals(second.code, "INVITE_INVALID");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager invite token — invalid token rejected",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const result = await auth.verifyInviteToken("nonexistent-token");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, "INVITE_INVALID");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager invite token — fallback identity when no tunnelId",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const invite = await auth.generateInviteToken(); // pas de tunnelId
    const result = await auth.verifyInviteToken(invite.token);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.identity.startsWith("tunnel-"), true);
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── Session tokens ───────────────────────────────────────

Deno.test({
  name: "AuthManager session token — happy path",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const session = await auth.generateSessionToken("tunnel-b");
    assertEquals(session.tunnelId, "tunnel-b");

    const result = await auth.verifySessionToken(session.token);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.identity, "tunnel-b");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager session token — invalid token rejected",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const result = await auth.verifySessionToken("fake-session");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, "SESSION_INVALID");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager session token — revocation",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const session = await auth.generateSessionToken("tunnel-c");
    await auth.revokeSessionToken(session.token);

    const result = await auth.verifySessionToken(session.token);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, "SESSION_INVALID");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── Agent tokens (credentials materialization) ───────────

Deno.test({
  name: "AuthManager agent token — happy path",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const { token } = await auth.materializeAgentToken("agent-x");
    const result = await auth.verifyAgentToken(token);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.identity, "agent-x");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager agent token — invalid rejected",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const result = await auth.verifyAgentToken("fake-agent-token");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, "AGENT_TOKEN_INVALID");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── checkRequest ─────────────────────────────────────────

Deno.test({
  name: "AuthManager checkRequest — local mode (no token configured)",
  async fn() {
    // S'assurer qu'il n'y a pas de token en env pour ce test
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.delete("DENOCLAW_API_TOKEN");

    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);
    const req = new Request("http://localhost/stats");

    const result = await auth.checkRequest(req);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.identity, "local");
    }

    // Restaurer
    if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — static token match",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "test-secret-42");

    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);
    const req = new Request("http://localhost/stats", {
      headers: { authorization: "Bearer test-secret-42" },
    });

    const result = await auth.checkRequest(req);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.identity, "static");
    }

    if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
    else Deno.env.delete("DENOCLAW_API_TOKEN");
    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — wrong token rejected",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "real-secret");

    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);
    const req = new Request("http://localhost/stats", {
      headers: { authorization: "Bearer wrong-token" },
    });

    const result = await auth.checkRequest(req);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, "AUTH_FAILED");
    }

    if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
    else Deno.env.delete("DENOCLAW_API_TOKEN");
    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — no token when token required",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "required-secret");

    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);
    const req = new Request("http://localhost/stats");

    const result = await auth.checkRequest(req);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, "UNAUTHORIZED");
    }

    if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
    else Deno.env.delete("DENOCLAW_API_TOKEN");
    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — session token via Bearer",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.delete("DENOCLAW_API_TOKEN");

    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);
    const session = await auth.generateSessionToken("tunnel-test");

    const req = new Request("http://localhost/stats", {
      headers: { authorization: `Bearer ${session.token}` },
    });

    const result = await auth.checkRequest(req);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.identity, "tunnel-test");
    }

    if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── OIDC ─────────────────────────────────────────────────

Deno.test({
  name: "AuthManager OIDC — unavailable in local mode",
  async fn() {
    const kv = await Deno.openKv();
    const auth = new AuthManager(kv);

    const result = await auth.verifyOIDC("some-token");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, "OIDC_UNAVAILABLE");
    }

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
