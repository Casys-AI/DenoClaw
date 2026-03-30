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
import { log } from "../shared/log.ts";
import { checkRequestAuth } from "./auth_request.ts";
import { AuthTokenStore } from "./auth_token_store.ts";
import type { AuthResult, InviteToken, SessionToken } from "./auth_types.ts";
export type {
  AuthErrorCode,
  AuthResult,
  InviteToken,
  SessionToken,
} from "./auth_types.ts";

// ── AuthManager ──────────────────────────────────────────

export class AuthManager {
  private tokenStore: AuthTokenStore;

  constructor(kv: Deno.Kv) {
    this.tokenStore = new AuthTokenStore(kv);
  }

  // ── Invite tokens (single-use, tunnel → broker) ────

  async generateInviteToken(tunnelId?: string): Promise<InviteToken> {
    return await this.tokenStore.generateInviteToken(tunnelId);
  }

  /**
   * Verifies and consumes an invite token via KV atomic (single-use guaranteed).
   * The atomic check prevents double use even under concurrent requests.
   */
  async verifyInviteToken(token: string): Promise<AuthResult> {
    return await this.tokenStore.verifyInviteToken(token);
  }

  // ── Session tokens (ephemeral, tunnel-lifetime) ──

  async generateSessionToken(
    tunnelId: string,
    agentId?: string,
  ): Promise<SessionToken> {
    return await this.tokenStore.generateSessionToken(tunnelId, agentId);
  }

  async verifySessionToken(token: string): Promise<AuthResult> {
    return await this.tokenStore.verifySessionToken(token);
  }

  async revokeSessionToken(token: string): Promise<void> {
    await this.tokenStore.revokeSessionToken(token);
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
    return await this.tokenStore.materializeAgentToken(agentId);
  }

  async verifyAgentToken(token: string): Promise<AuthResult> {
    return await this.tokenStore.verifyAgentToken(token);
  }

  // ── HTTP middleware ──────────────────────────────────

  /**
   * Verifies HTTP request authentication (ADR-003).
   *
   * Order: static token → session → agent → OIDC.
   * If no token is configured and none is provided → local mode without auth.
   */
  async checkRequest(req: Request): Promise<AuthResult> {
    return await checkRequestAuth({
      req,
      staticToken: Deno.env.get("DENOCLAW_API_TOKEN") ?? undefined,
      verifySessionToken: (token) => this.verifySessionToken(token),
      verifyAgentToken: (token) => this.verifyAgentToken(token),
      verifyOIDC: (token) => this.verifyOIDC(token),
    });
  }
}
