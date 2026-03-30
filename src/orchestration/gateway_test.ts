import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  GATEWAY_WS_IDLE_TIMEOUT_SECONDS,
  getDashboardAllowedUsers,
  getDashboardAuthMode,
  parseGatewayWsChatPayload,
} from "./gateway/server.ts";

// ── getDashboardAuthMode ───────────────────────────────────

Deno.test({
  name: "getDashboardAuthMode — defaults to local-open when no env vars set",
  fn() {
    const prevAuth = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
    const prevDeploy = Deno.env.get("DENO_DEPLOYMENT_ID");
    Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
    Deno.env.delete("DENO_DEPLOYMENT_ID");

    const mode = getDashboardAuthMode();
    assertEquals(mode, "local-open");

    if (prevAuth) Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", prevAuth);
    if (prevDeploy) Deno.env.set("DENO_DEPLOYMENT_ID", prevDeploy);
  },
});

Deno.test({
  name:
    "getDashboardAuthMode — returns github-oauth when DENO_DEPLOYMENT_ID is set",
  fn() {
    const prevAuth = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
    const prevDeploy = Deno.env.get("DENO_DEPLOYMENT_ID");
    Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
    Deno.env.set("DENO_DEPLOYMENT_ID", "some-deployment-id");

    const mode = getDashboardAuthMode();
    assertEquals(mode, "github-oauth");

    if (prevAuth) Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", prevAuth);
    else Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
    if (prevDeploy) Deno.env.set("DENO_DEPLOYMENT_ID", prevDeploy);
    else Deno.env.delete("DENO_DEPLOYMENT_ID");
  },
});

Deno.test({
  name: "getDashboardAuthMode — DENOCLAW_DASHBOARD_AUTH_MODE=token → token",
  fn() {
    const prev = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
    Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", "token");

    const mode = getDashboardAuthMode();
    assertEquals(mode, "token");

    if (prev) Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", prev);
    else Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
  },
});

Deno.test({
  name:
    "getDashboardAuthMode — DENOCLAW_DASHBOARD_AUTH_MODE=github → github-oauth",
  fn() {
    const prev = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
    Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", "github");

    const mode = getDashboardAuthMode();
    assertEquals(mode, "github-oauth");

    if (prev) Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", prev);
    else Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
  },
});

Deno.test({
  name:
    "getDashboardAuthMode — DENOCLAW_DASHBOARD_AUTH_MODE=oauth → github-oauth",
  fn() {
    const prev = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
    Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", "oauth");

    const mode = getDashboardAuthMode();
    assertEquals(mode, "github-oauth");

    if (prev) Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", prev);
    else Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
  },
});

Deno.test({
  name:
    "getDashboardAuthMode — DENOCLAW_DASHBOARD_AUTH_MODE=github-oauth → github-oauth",
  fn() {
    const prev = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
    Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", "github-oauth");

    const mode = getDashboardAuthMode();
    assertEquals(mode, "github-oauth");

    if (prev) Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", prev);
    else Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
  },
});

Deno.test({
  name:
    "getDashboardAuthMode — unknown value falls back to DENO_DEPLOYMENT_ID logic",
  fn() {
    const prevAuth = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
    const prevDeploy = Deno.env.get("DENO_DEPLOYMENT_ID");
    Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", "unknown-value");
    Deno.env.delete("DENO_DEPLOYMENT_ID");

    const mode = getDashboardAuthMode();
    assertEquals(mode, "local-open");

    if (prevAuth) Deno.env.set("DENOCLAW_DASHBOARD_AUTH_MODE", prevAuth);
    else Deno.env.delete("DENOCLAW_DASHBOARD_AUTH_MODE");
    if (prevDeploy) Deno.env.set("DENO_DEPLOYMENT_ID", prevDeploy);
  },
});

// ── getDashboardAllowedUsers ───────────────────────────────

Deno.test({
  name: "getDashboardAllowedUsers — returns undefined when no env var set",
  fn() {
    const prev1 = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    const prev2 = Deno.env.get("GITHUB_ALLOWED_USERS");
    Deno.env.delete("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    Deno.env.delete("GITHUB_ALLOWED_USERS");

    const result = getDashboardAllowedUsers();
    assertStrictEquals(result, undefined);

    if (prev1) Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", prev1);
    if (prev2) Deno.env.set("GITHUB_ALLOWED_USERS", prev2);
  },
});

Deno.test({
  name:
    "getDashboardAllowedUsers — parses comma-separated list from primary var",
  fn() {
    const prev1 = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    const prev2 = Deno.env.get("GITHUB_ALLOWED_USERS");
    Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", "alice,bob,carol");
    Deno.env.delete("GITHUB_ALLOWED_USERS");

    const result = getDashboardAllowedUsers();
    assertEquals(result, ["alice", "bob", "carol"]);

    if (prev1) Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", prev1);
    else Deno.env.delete("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    if (prev2) Deno.env.set("GITHUB_ALLOWED_USERS", prev2);
  },
});

Deno.test({
  name: "getDashboardAllowedUsers — falls back to GITHUB_ALLOWED_USERS",
  fn() {
    const prev1 = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    const prev2 = Deno.env.get("GITHUB_ALLOWED_USERS");
    Deno.env.delete("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    Deno.env.set("GITHUB_ALLOWED_USERS", "dave,eve");

    const result = getDashboardAllowedUsers();
    assertEquals(result, ["dave", "eve"]);

    if (prev1) Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", prev1);
    if (prev2) Deno.env.set("GITHUB_ALLOWED_USERS", prev2);
    else Deno.env.delete("GITHUB_ALLOWED_USERS");
  },
});

Deno.test({
  name: "getDashboardAllowedUsers — trims whitespace around usernames",
  fn() {
    const prev = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", " alice , bob ");

    const result = getDashboardAllowedUsers();
    assertEquals(result, ["alice", "bob"]);

    if (prev) Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", prev);
    else Deno.env.delete("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
  },
});

Deno.test({
  name: "getDashboardAllowedUsers — empty string returns undefined",
  fn() {
    const prev1 = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    const prev2 = Deno.env.get("GITHUB_ALLOWED_USERS");
    Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", "");
    Deno.env.delete("GITHUB_ALLOWED_USERS");

    const result = getDashboardAllowedUsers();
    // empty string → no users after filter → undefined
    assertStrictEquals(result, undefined);

    if (prev1) Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", prev1);
    else Deno.env.delete("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    if (prev2) Deno.env.set("GITHUB_ALLOWED_USERS", prev2);
  },
});

Deno.test({
  name: "getDashboardAllowedUsers — single user returns one-element array",
  fn() {
    const prev = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
    Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", "solo");

    const result = getDashboardAllowedUsers();
    assertEquals(result, ["solo"]);

    if (prev) Deno.env.set("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS", prev);
    else Deno.env.delete("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS");
  },
});

// ── parseGatewayWsChatPayload ─────────────────────────────

Deno.test({
  name: "parseGatewayWsChatPayload — accepts strict chat payload",
  fn() {
    const payload = parseGatewayWsChatPayload(JSON.stringify({
      type: "chat",
      agentId: "agent-alpha",
      sessionId: "session-1",
      message: "hello",
    }));

    assertEquals(payload, {
      type: "chat",
      agentId: "agent-alpha",
      sessionId: "session-1",
      message: "hello",
    });
  },
});

Deno.test({
  name: "parseGatewayWsChatPayload — rejects unknown message types",
  fn() {
    const err = (() => {
      try {
        parseGatewayWsChatPayload(JSON.stringify({
          type: "ping",
          agentId: "agent-alpha",
          message: "hello",
        }));
      } catch (error) {
        return error as Error;
      }
      return null;
    })();

    assertEquals(err?.message.includes("INVALID_INPUT"), true);
  },
});

Deno.test({
  name:
    "parseGatewayWsChatPayload — rejects empty message and non-string sessionId",
  fn() {
    const emptyMessageErr = (() => {
      try {
        parseGatewayWsChatPayload(JSON.stringify({
          type: "chat",
          agentId: "agent-alpha",
          message: "",
        }));
      } catch (error) {
        return error as Error;
      }
      return null;
    })();
    assertEquals(emptyMessageErr?.message.includes("INVALID_INPUT"), true);

    const badSessionErr = (() => {
      try {
        parseGatewayWsChatPayload(JSON.stringify({
          type: "chat",
          agentId: "agent-alpha",
          message: "ok",
          sessionId: 42,
        }));
      } catch (error) {
        return error as Error;
      }
      return null;
    })();
    assertEquals(badSessionErr?.message.includes("INVALID_INPUT"), true);
  },
});

Deno.test({
  name: "gateway WS idle timeout remains explicit and non-zero",
  fn() {
    assertEquals(GATEWAY_WS_IDLE_TIMEOUT_SECONDS > 0, true);
  },
});
