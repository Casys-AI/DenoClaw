import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";
import type { AuthResult, InviteToken, SessionToken } from "./auth_types.ts";

const INVITE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AGENT_TOKEN_TTL_MS = 30 * 60 * 1000;

export class AuthTokenStore {
  constructor(private readonly kv: Deno.Kv) {}

  async generateInviteToken(tunnelId?: string): Promise<InviteToken> {
    const token = generateId();
    const now = new Date();

    const invite: InviteToken = {
      token,
      tunnelId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    };

    await this.kv.set(["auth", "invite", token], invite, {
      expireIn: INVITE_TTL_MS,
    });
    log.info(
      `Invite token generated${tunnelId ? ` for tunnel ${tunnelId}` : ""}`,
    );

    return invite;
  }

  async verifyInviteToken(token: string): Promise<AuthResult> {
    const key: Deno.KvKey = ["auth", "invite", token];
    const entry = await this.kv.get<InviteToken>(key);

    if (!entry.value) {
      return {
        ok: false,
        code: "INVITE_INVALID",
        recovery: "Generate a new invite token via the broker CLI",
      };
    }

    const expiry = new Date(entry.value.expiresAt);
    if (isNaN(expiry.getTime()) || expiry < new Date()) {
      await this.kv.delete(key);
      return {
        ok: false,
        code: "INVITE_EXPIRED",
        recovery: "Generate a new invite token (TTL: 15 minutes)",
      };
    }

    const result = await this.kv.atomic()
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

  async generateSessionToken(
    tunnelId: string,
    agentId?: string,
  ): Promise<SessionToken> {
    const token = generateId();
    const now = new Date();

    const session: SessionToken = {
      token,
      tunnelId,
      agentId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };

    await this.kv.set(["auth", "session", token], session, {
      expireIn: SESSION_TTL_MS,
    });
    log.debug(`Session token generated for tunnel ${tunnelId}`);

    return session;
  }

  async verifySessionToken(token: string): Promise<AuthResult> {
    const entry = await this.kv.get<SessionToken>(["auth", "session", token]);

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
      await this.kv.delete(["auth", "session", token]);
      return {
        ok: false,
        code: "SESSION_EXPIRED",
        recovery: "Reconnect with a new invite token",
      };
    }

    return { ok: true, identity: entry.value.tunnelId };
  }

  async revokeSessionToken(token: string): Promise<void> {
    await this.kv.delete(["auth", "session", token]);
    log.debug("Session token revoked");
  }

  async materializeAgentToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = generateId();
    const expiresAt = new Date(Date.now() + AGENT_TOKEN_TTL_MS).toISOString();

    await this.kv.set(["auth", "agent", token], { agentId, expiresAt }, {
      expireIn: AGENT_TOKEN_TTL_MS,
    });
    log.debug(`Agent token materialized for ${agentId}`);

    return { token, expiresAt };
  }

  async verifyAgentToken(token: string): Promise<AuthResult> {
    const entry = await this.kv.get<{ agentId: string; expiresAt: string }>([
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
      await this.kv.delete(["auth", "agent", token]);
      return {
        ok: false,
        code: "AGENT_TOKEN_EXPIRED",
        recovery: "Sandbox session expired (max 30 min)",
      };
    }

    return { ok: true, identity: entry.value.agentId };
  }
}
