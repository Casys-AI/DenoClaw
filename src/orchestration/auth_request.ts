import type { AuthResult } from "./auth_types.ts";

export interface CheckRequestAuthInput {
  req: Request;
  staticToken?: string;
  verifySessionToken(token: string): Promise<AuthResult>;
  verifyAgentToken(token: string): Promise<AuthResult>;
  verifyOIDC(token: string): Promise<AuthResult>;
}

export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export function resolveRequestAuthToken(req: Request): string | null {
  return extractBearerToken(req) ||
    new URL(req.url).searchParams.get("token");
}

export async function checkRequestAuth(
  input: CheckRequestAuthInput,
): Promise<AuthResult> {
  const token = resolveRequestAuthToken(input.req);

  if (!input.staticToken && !token) {
    return { ok: true, identity: "local" };
  }

  if (token) {
    if (input.staticToken && token === input.staticToken) {
      return { ok: true, identity: "static" };
    }

    const sessionResult = await input.verifySessionToken(token);
    if (sessionResult.ok) return sessionResult;

    const agentResult = await input.verifyAgentToken(token);
    if (agentResult.ok) return agentResult;

    const oidcResult = await input.verifyOIDC(token);
    if (oidcResult.ok) return oidcResult;
  }

  if (input.staticToken && !token) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      recovery: "Add Authorization: Bearer <token> header",
    };
  }

  return {
    ok: false,
    code: "AUTH_FAILED",
    recovery:
      "Token invalid. Use a valid invite, session, agent, or static token.",
  };
}
