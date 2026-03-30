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
