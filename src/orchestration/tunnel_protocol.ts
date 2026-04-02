import type { SandboxPermission } from "../shared/types.ts";
import { OrchestrationError } from "../shared/errors.ts";

export const DENOCLAW_TUNNEL_PROTOCOL = "denoclaw.tunnel.v1";
export const TUNNEL_IDLE_TIMEOUT_SECONDS = 30;
export const WS_BUFFERED_AMOUNT_HIGH_WATERMARK = 1_048_576;

export type TunnelRegistrationType = "local" | "instance";

export interface TunnelRegisterMessage {
  type: "register";
  tunnelType: TunnelRegistrationType;
  tools: string[];
  toolPermissions?: Record<string, SandboxPermission[]>;
  agents: string[];
  allowedAgents: string[];
}

export interface TunnelRegisteredMessage {
  type: "registered";
  tunnelId: string;
}

export interface TunnelSessionTokenMessage {
  type: "session_token";
  token: string;
  expiresAt: string;
}

export type TunnelControlMessage =
  | TunnelRegisteredMessage
  | TunnelSessionTokenMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

const SANDBOX_PERMISSIONS: ReadonlySet<SandboxPermission> = new Set([
  "read",
  "write",
  "run",
  "net",
  "env",
  "ffi",
]);

function isSandboxPermission(value: unknown): value is SandboxPermission {
  return typeof value === "string" &&
    SANDBOX_PERMISSIONS.has(value as SandboxPermission);
}

function isToolPermissions(
  value: unknown,
): value is Record<string, SandboxPermission[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((permissions) =>
    Array.isArray(permissions) && permissions.every(isSandboxPermission)
  );
}

export function createTunnelRegisterMessage(input: {
  tunnelType: TunnelRegistrationType;
  tools: string[];
  toolPermissions?: Record<string, SandboxPermission[]>;
  agents?: string[];
  allowedAgents?: string[];
}): TunnelRegisterMessage {
  return {
    type: "register",
    tunnelType: input.tunnelType,
    tools: [...input.tools],
    ...(input.toolPermissions
      ? { toolPermissions: input.toolPermissions }
      : {}),
    agents: [...(input.agents ?? [])],
    allowedAgents: [...(input.allowedAgents ?? [])],
  };
}

export function assertTunnelRegisterMessage(
  value: unknown,
): TunnelRegisterMessage {
  if (!isRecord(value) || value.type !== "register") {
    throw new OrchestrationError(
      "TUNNEL_REGISTER_INVALID",
      { field: "type", expected: "register" },
      "Send a message with type 'register'",
    );
  }
  if (value.tunnelType !== "local" && value.tunnelType !== "instance") {
    throw new OrchestrationError(
      "TUNNEL_REGISTER_INVALID",
      { field: "tunnelType", expected: "local | instance" },
      "Set tunnelType to 'local' or 'instance'",
    );
  }
  if (!isStringArray(value.tools)) {
    throw new OrchestrationError(
      "TUNNEL_REGISTER_INVALID",
      { field: "tools", expected: "string[]" },
      "Declare tools as a string array",
    );
  }
  if (!isStringArray(value.agents)) {
    throw new OrchestrationError(
      "TUNNEL_REGISTER_INVALID",
      { field: "agents", expected: "string[]" },
      "Declare agents as a string array",
    );
  }
  if (!isStringArray(value.allowedAgents)) {
    throw new OrchestrationError(
      "TUNNEL_REGISTER_INVALID",
      { field: "allowedAgents", expected: "string[]" },
      "Declare allowedAgents as a string array",
    );
  }
  if (
    value.toolPermissions !== undefined &&
    !isToolPermissions(value.toolPermissions)
  ) {
    throw new OrchestrationError(
      "TUNNEL_REGISTER_INVALID",
      { field: "toolPermissions", expected: "Record<string, SandboxPermission[]>" },
      "Declare toolPermissions as permission arrays",
    );
  }
  return {
    type: "register",
    tunnelType: value.tunnelType,
    tools: value.tools,
    ...(value.toolPermissions
      ? { toolPermissions: value.toolPermissions }
      : {}),
    agents: value.agents,
    allowedAgents: value.allowedAgents,
  };
}

export function parseTunnelControlMessage(
  value: unknown,
): TunnelControlMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type === "registered") {
    if (typeof value.tunnelId !== "string" || value.tunnelId.length === 0) {
      throw new OrchestrationError(
        "TUNNEL_CONTROL_INVALID",
        { field: "tunnelId", messageType: "registered" },
        "Include a non-empty tunnelId in the registered message",
      );
    }
    return {
      type: "registered",
      tunnelId: value.tunnelId,
    };
  }

  if (value.type === "session_token") {
    if (typeof value.token !== "string" || value.token.length === 0) {
      throw new OrchestrationError(
        "TUNNEL_CONTROL_INVALID",
        { field: "token", messageType: "session_token" },
        "Include a non-empty token in the session_token message",
      );
    }
    if (typeof value.expiresAt !== "string" || value.expiresAt.length === 0) {
      throw new OrchestrationError(
        "TUNNEL_CONTROL_INVALID",
        { field: "expiresAt", messageType: "session_token" },
        "Include a non-empty expiresAt in the session_token message",
      );
    }
    return {
      type: "session_token",
      token: value.token,
      expiresAt: value.expiresAt,
    };
  }

  return null;
}

export function parseWebSocketProtocols(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getAcceptedTunnelProtocol(
  header: string | null,
): string | undefined {
  const protocols = parseWebSocketProtocols(header);
  return protocols.includes(DENOCLAW_TUNNEL_PROTOCOL)
    ? DENOCLAW_TUNNEL_PROTOCOL
    : undefined;
}
