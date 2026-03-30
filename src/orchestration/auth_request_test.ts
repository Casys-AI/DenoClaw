import { assertEquals } from "@std/assert";
import {
  checkRequestAuth,
  extractBearerToken,
  resolveRequestAuthToken,
} from "./auth_request.ts";
import type { AuthResult } from "./auth_types.ts";

function createVerifier(identity: string, acceptedToken: string) {
  return (token: string): Promise<AuthResult> =>
    Promise.resolve(
      token === acceptedToken ? { ok: true, identity } : {
        ok: false,
        code: "AUTH_FAILED",
        recovery: "Invalid",
      },
    );
}

Deno.test("extractBearerToken reads bearer headers only", () => {
  const req = new Request("https://broker.example/health", {
    headers: { authorization: "Bearer session-123" },
  });

  assertEquals(extractBearerToken(req), "session-123");
  assertEquals(
    extractBearerToken(
      new Request("https://broker.example/health", {
        headers: { authorization: "Basic abc" },
      }),
    ),
    null,
  );
});

Deno.test("resolveRequestAuthToken falls back to query token", () => {
  const req = new Request("https://broker.example/health?token=query-123");
  assertEquals(resolveRequestAuthToken(req), "query-123");
});

Deno.test("checkRequestAuth returns local identity when auth is not configured", async () => {
  const result = await checkRequestAuth({
    req: new Request("https://broker.example/health"),
    verifySessionToken: createVerifier("session", "session-123"),
    verifyAgentToken: createVerifier("agent", "agent-123"),
    verifyOIDC: createVerifier("oidc", "oidc-123"),
  });

  assertEquals(result, { ok: true, identity: "local" });
});

Deno.test("checkRequestAuth preserves static token priority", async () => {
  const result = await checkRequestAuth({
    req: new Request("https://broker.example/health", {
      headers: { authorization: "Bearer static-123" },
    }),
    staticToken: "static-123",
    verifySessionToken: createVerifier("session", "static-123"),
    verifyAgentToken: createVerifier("agent", "static-123"),
    verifyOIDC: createVerifier("oidc", "static-123"),
  });

  assertEquals(result, { ok: true, identity: "static" });
});

Deno.test("checkRequestAuth falls through session then agent then OIDC", async () => {
  const result = await checkRequestAuth({
    req: new Request("https://broker.example/health?token=agent-123"),
    verifySessionToken: createVerifier("session", "session-123"),
    verifyAgentToken: createVerifier("agent", "agent-123"),
    verifyOIDC: createVerifier("oidc", "oidc-123"),
  });

  assertEquals(result, { ok: true, identity: "agent" });
});
