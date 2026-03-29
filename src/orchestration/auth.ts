/**
 * AuthManager — authentication and authorization for the broker (ADR-003).
 *
 * Manages three mechanisms:
 * 1. Invite tokens: single-use (atomic), for a tunnel's initial connection
 * 2. Session tokens: ephemeral, limited lifetime, for an active tunnel session
 * 3. OIDC: verification of Deno Deploy tokens (@deno/oidc) when available
 *
 * Fallback: if DENOCLAW_API_TOKEN is defined in env, it acts as a static token
 * (local / dev mode). In Deploy production, everything uses OIDC + invite tokens.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";

// ── Types ────────────────────────────────────────────────

export type AuthErrorCode =
  | "INVITE_INVALID"
  | "INVITE_ALREADY_USED"
  | "INVITE_EXPIRED"
  | "SESSION_INVALID"
  | "SESSION_EXPIRED"
  | "AGENT_TOKEN_INVALID"
  | "AGENT_TOKEN_EXPIRED"
  | "OIDC_INVALID_PAYLOAD"
  | "OIDC_UNAVAILABLE"
  | "OIDC_VERIFICATION_FAILED"
  | "UNAUTHORIZED"
  | "AUTH_FAILED";

export interface InviteToken {
  token: string;
  /** Authorized tunnel identifier (if known). */
  tunnelId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface SessionToken {
  token: string;
  tunnelId: string;
  agentId?: string;
  createdAt: string;
  expiresAt: string;
}

export type AuthResult =
  | { ok: true; identity: string }
  | { ok: false; code: AuthErrorCode; recovery: string };

// ── Constants ────────────────────────────────────────────

const INVITE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const AGENT_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min (maximum Sandbox lifetime)

// ── AuthManager ──────────────────────────────────────────

export class AuthManager {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  // ── Invite tokens (single-use, tunnel → broker) ────

  async generateInviteToken(tunnelId?: string): Promise<InviteToken> {
    const kv = this.kv;
    const token = generateId();
    const now = new Date();

    const invite: InviteToken = {
      token,
      tunnelId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    };

    await kv.set(["auth", "invite", token], invite, {
      expireIn: INVITE_TTL_MS,
    });
    log.info(
      `Invite token generated${tunnelId ? ` for tunnel ${tunnelId}` : ""}`,
    );

    return invite;
  }

  /**
   * Verifies and consumes an invite token via KV atomic (single-use guaranteed).
   * The atomic check prevents double use even under concurrent requests.
   */
  async verifyInviteToken(token: string): Promise<AuthResult> {
    const kv = this.kv;
    const key: Deno.KvKey = ["auth", "invite", token];
    const entry = await kv.get<InviteToken>(key);

    if (!entry.value) {
      return {
        ok: false,
        code: "INVITE_INVALID",
        recovery: "Generate a new invite token via the broker CLI",
      };
    }

    const expiry = new Date(entry.value.expiresAt);
    if (isNaN(expiry.getTime()) || expiry < new Date()) {
      await kv.delete(key);
      return {
        ok: false,
        code: "INVITE_EXPIRED",
        recovery: "Generate a new invite token (TTL: 15 minutes)",
      };
    }

    // Atomic check-and-delete: fails if the entry changed/was deleted between read and delete
    const result = await kv.atomic()
      .check(entry)
      .delete(key)
      .commit();

    if (!result.ok) {
      return {
        ok: false,
        code: "INVITE_ALREADY_USED",
        recovery: "Generate a new invite token",
      };
    }

    log.info(
      `Invite token consumed${
        entry.value.tunnelId ? ` (tunnel: ${entry.value.tunnelId})` : ""
      }`,
    );
    return {
      ok: true,
      identity: entry.value.tunnelId || `tunnel-${token.slice(0, 8)}`,
    };
  }

  // ── Session tokens (ephemeral, tunnel-lifetime) ──

  async generateSessionToken(
    tunnelId: string,
    agentId?: string,
  ): Promise<SessionToken> {
    const kv = this.kv;
    const token = generateId();
    const now = new Date();

    const session: SessionToken = {
      token,
      tunnelId,
      agentId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };

    await kv.set(["auth", "session", token], session, {
      expireIn: SESSION_TTL_MS,
    });
    log.debug(`Session token generated for tunnel ${tunnelId}`);

    return session;
  }

  async verifySessionToken(token: string): Promise<AuthResult> {
    const kv = this.kv;
    const entry = await kv.get<SessionToken>(["auth", "session", token]);

    if (!entry.value) {
      return {
        ok: false,
        code: "SESSION_INVALID",
        recovery: "Reconnect with a valid invite token",
      };
    }

    const expiry = new Date(entry.value.expiresAt);
    if (isNaN(expiry.getTime()) || expiry < new Date()) {
      log.warn("Session token expired", { tunnelId: entry.value.tunnelId });
      await kv.delete(["auth", "session", token]);
      return {
        ok: false,
        code: "SESSION_EXPIRED",
        recovery: "Reconnect with a new invite token",
      };
    }

    return { ok: true, identity: entry.value.tunnelId };
  }

  async revokeSessionToken(token: string): Promise<void> {
    const kv = this.kv;
    await kv.delete(["auth", "session", token]);
    log.debug("Session token revoked");
  }

  // ── OIDC (Deno Deploy → Deno Deploy) ─────────────────

  private jwks = createRemoteJWKSet(
    new URL("https://oidc.deno.com/.well-known/jwks.json"),
  );
  private expectedAudience?: string;

  /** Set the expected OIDC audience (broker URL). Required for OIDC verification. */
  setOIDCAudience(audience: string): void {
    this.expectedAudience = audience;
  }

  /**
   * Verifies an OIDC token issued by Deno Deploy via JWKS (ADR-003).
   * jose verifies signature, issuer, audience, and expiry.
   * JWKS is cached and auto-refreshed on key rotation.
   */
  async verifyOIDC(token: string): Promise<AuthResult> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: "https://oidc.deno.com",
        audience: this.expectedAudience,
      });

      if (!payload.sub) {
        return {
          ok: false,
          code: "OIDC_INVALID_PAYLOAD",
          recovery: "OIDC token has no subject",
        };
      }

      log.debug(`OIDC verified: sub=${payload.sub}`);
      return { ok: true, identity: payload.sub as string };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`OIDC verification failed: ${msg}`);
      return {
        ok: false,
        code: "OIDC_VERIFICATION_FAILED",
        recovery:
          "OIDC token verification failed. Check token freshness and issuer.",
      };
    }
  }

  // ── Credentials materialization (Sandbox → Broker) ───

  async materializeAgentToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const kv = this.kv;
    const token = generateId();
    const expiresAt = new Date(Date.now() + AGENT_TOKEN_TTL_MS).toISOString();

    await kv.set(["auth", "agent", token], { agentId, expiresAt }, {
      expireIn: AGENT_TOKEN_TTL_MS,
    });
    log.debug(`Agent token materialized for ${agentId}`);

    return { token, expiresAt };
  }

  async verifyAgentToken(token: string): Promise<AuthResult> {
    const kv = this.kv;
    const entry = await kv.get<{ agentId: string; expiresAt: string }>([
      "auth",
      "agent",
      token,
    ]);

    if (!entry.value) {
      return {
        ok: false,
        code: "AGENT_TOKEN_INVALID",
        recovery: "Token not found or expired",
      };
    }

    const expiry = new Date(entry.value.expiresAt);
    if (isNaN(expiry.getTime()) || expiry < new Date()) {
      await kv.delete(["auth", "agent", token]);
      return {
        ok: false,
        code: "AGENT_TOKEN_EXPIRED",
        recovery: "Sandbox session expired (max 30 min)",
      };
    }

    return { ok: true, identity: entry.value.agentId };
  }

  // ── HTTP middleware ──────────────────────────────────

  /**
   * Verifies HTTP request authentication (ADR-003).
   *
   * Order: static token → session → agent → OIDC.
   * If no token is configured and none is provided → local mode without auth.
   */
  async checkRequest(req: Request): Promise<AuthResult> {
    const staticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    const bearer = this.extractBearer(req);
    const queryToken = new URL(req.url).searchParams.get("token");
    const token = bearer || queryToken;

    // No configured token and no provided token → local mode without auth
    if (!staticToken && !token) {
      return { ok: true, identity: "local" };
    }

    if (token) {
      // 1. Static token match
      if (staticToken && token === staticToken) {
        return { ok: true, identity: "static" };
      }

      // 2. Session token
      const sessionResult = await this.verifySessionToken(token);
      if (sessionResult.ok) return sessionResult;

      // 3. Agent token
      const agentResult = await this.verifyAgentToken(token);
      if (agentResult.ok) return agentResult;

      // 4. OIDC (last resort, slower)
      const oidcResult = await this.verifyOIDC(token);
      if (oidcResult.ok) return oidcResult;
    }

    if (staticToken && !token) {
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

  private extractBearer(req: Request): string | null {
    const auth = req.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) return null;
    return auth.slice(7);
  }
}
