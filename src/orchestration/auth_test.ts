import { assertEquals } from "@std/assert";
import { AuthManager } from "./auth.ts";

async function withTempAuthManager(
  fn: (auth: AuthManager, kv: Deno.Kv) => Promise<void>,
): Promise<void> {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  const auth = new AuthManager(kv);
  try {
    await fn(auth, kv);
  } finally {
    kv.close();
    try {
      await Deno.remove(kvPath);
    } catch {
      /* ignore */
    }
  }
}

// ── Invite tokens ────────────────────────────────────────

Deno.test({
  name: "AuthManager invite token — happy path",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const invite = await auth.generateInviteToken("tunnel-a");
      assertEquals(typeof invite.token, "string");
      assertEquals(invite.tunnelId, "tunnel-a");

      const result = await auth.verifyInviteToken(invite.token);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.identity, "tunnel-a");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager invite token — double-use rejected (atomic)",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const invite = await auth.generateInviteToken();

      const first = await auth.verifyInviteToken(invite.token);
      assertEquals(first.ok, true);

      const second = await auth.verifyInviteToken(invite.token);
      assertEquals(second.ok, false);
      if (!second.ok) {
        assertEquals(second.code, "INVITE_INVALID");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager invite token — invalid token rejected",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const result = await auth.verifyInviteToken("nonexistent-token");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.code, "INVITE_INVALID");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager invite token — fallback identity when no tunnelId",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const invite = await auth.generateInviteToken();
      const result = await auth.verifyInviteToken(invite.token);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.identity.startsWith("tunnel-"), true);
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── Session tokens ───────────────────────────────────────

Deno.test({
  name: "AuthManager session token — happy path",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const session = await auth.generateSessionToken("tunnel-b");
      assertEquals(session.tunnelId, "tunnel-b");

      const result = await auth.verifySessionToken(session.token);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.identity, "tunnel-b");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager session token — invalid token rejected",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const result = await auth.verifySessionToken("fake-session");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.code, "SESSION_INVALID");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager session token — revocation",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const session = await auth.generateSessionToken("tunnel-c");
      await auth.revokeSessionToken(session.token);

      const result = await auth.verifySessionToken(session.token);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.code, "SESSION_INVALID");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── Agent tokens (credentials materialization) ───────────

Deno.test({
  name: "AuthManager agent token — happy path",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const { token } = await auth.materializeAgentToken("agent-x");
      const result = await auth.verifyAgentToken(token);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.identity, "agent-x");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager agent token — invalid rejected",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const result = await auth.verifyAgentToken("fake-agent-token");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.code, "AGENT_TOKEN_INVALID");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── checkRequest ─────────────────────────────────────────

Deno.test({
  name: "AuthManager checkRequest — local mode (no token configured)",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.delete("DENOCLAW_API_TOKEN");
    try {
      await withTempAuthManager(async (auth) => {
        const req = new Request("http://localhost/stats");
        const result = await auth.checkRequest(req);
        assertEquals(result.ok, true);
        if (result.ok) {
          assertEquals(result.identity, "local");
        }
      });
    } finally {
      if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — static token match",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "test-secret-42");
    try {
      await withTempAuthManager(async (auth) => {
        const req = new Request("http://localhost/stats", {
          headers: { authorization: "Bearer test-secret-42" },
        });

        const result = await auth.checkRequest(req);
        assertEquals(result.ok, true);
        if (result.ok) {
          assertEquals(result.identity, "static");
        }
      });
    } finally {
      if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
      else Deno.env.delete("DENOCLAW_API_TOKEN");
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — wrong token rejected",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "real-secret");
    try {
      await withTempAuthManager(async (auth) => {
        const req = new Request("http://localhost/stats", {
          headers: { authorization: "Bearer wrong-token" },
        });

        const result = await auth.checkRequest(req);
        assertEquals(result.ok, false);
        if (!result.ok) {
          assertEquals(result.code, "AUTH_FAILED");
        }
      });
    } finally {
      if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
      else Deno.env.delete("DENOCLAW_API_TOKEN");
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — no token when token required",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "required-secret");
    try {
      await withTempAuthManager(async (auth) => {
        const req = new Request("http://localhost/stats");
        const result = await auth.checkRequest(req);
        assertEquals(result.ok, false);
        if (!result.ok) {
          assertEquals(result.code, "UNAUTHORIZED");
        }
      });
    } finally {
      if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
      else Deno.env.delete("DENOCLAW_API_TOKEN");
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AuthManager checkRequest — session token via Bearer",
  async fn() {
    const prev = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.delete("DENOCLAW_API_TOKEN");
    try {
      await withTempAuthManager(async (auth) => {
        const session = await auth.generateSessionToken("tunnel-test");
        const req = new Request("http://localhost/stats", {
          headers: { authorization: `Bearer ${session.token}` },
        });

        const result = await auth.checkRequest(req);
        assertEquals(result.ok, true);
        if (result.ok) {
          assertEquals(result.identity, "tunnel-test");
        }
      });
    } finally {
      if (prev) Deno.env.set("DENOCLAW_API_TOKEN", prev);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── OIDC ─────────────────────────────────────────────────

Deno.test({
  name: "AuthManager OIDC — invalid token rejected",
  async fn() {
    await withTempAuthManager(async (auth) => {
      const result = await auth.verifyOIDC("not-a-valid-jwt");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.code, "OIDC_VERIFICATION_FAILED");
      }
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
