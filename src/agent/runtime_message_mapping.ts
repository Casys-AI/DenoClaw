import {
  getAwaitedInputMetadata,
  getResumePayloadMetadata,
} from "../messaging/a2a/input_metadata.ts";
import type { RuntimeTaskContinuePayload } from "./runtime_transport.ts";
import type { A2AMessage } from "../messaging/a2a/types.ts";
import type { ToolResult } from "../shared/types.ts";
import type { AgentRuntimePrivilegeElevationGrant } from "./runtime_capabilities.ts";
import type {
  PrivilegeElevationGrantResource,
  PrivilegeElevationScope,
} from "../shared/privilege_elevation.ts";
import { formatPrivilegeElevationPrompt } from "../shared/privilege_elevation.ts";

export interface RuntimePrivilegeElevationPause {
  grants: PrivilegeElevationGrantResource[];
  scope: PrivilegeElevationScope;
  command?: string;
  binary?: string;
  prompt: string;
  expiresAt?: string;
}

export function extractApprovedPrivilegeElevationGrant(
  task: { status: { metadata?: Record<string, unknown> } },
  payload?: Pick<RuntimeTaskContinuePayload, "metadata">,
): AgentRuntimePrivilegeElevationGrant | null {
  const resume = payload?.metadata
    ? getResumePayloadMetadata({ metadata: payload.metadata })
    : undefined;
  if (
    !resume || resume.kind !== "privilege-elevation" ||
    resume.approved !== true ||
    !Array.isArray(resume.grants)
  ) {
    return null;
  }

  const awaitedInput = getAwaitedInputMetadata(task.status);
  if (!awaitedInput || awaitedInput.kind !== "privilege-elevation") return null;

  return {
    kind: "privilege-elevation",
    scope: resume.scope ?? awaitedInput.scope,
    grants: resume.grants.length > 0 ? resume.grants : awaitedInput.grants,
    grantedAt: new Date().toISOString(),
    source: "broker-resume",
  };
}

export function extractRuntimeTaskText(message: A2AMessage): string {
  const text = message.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> =>
      part.kind === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text || "[non-text task payload]";
}

export function extractRuntimePrivilegeElevationPause(
  result: ToolResult,
): RuntimePrivilegeElevationPause | null {
  if (result.success || result.error?.code !== "PRIVILEGE_ELEVATION_REQUIRED") {
    return null;
  }

  const context = result.error.context;
  if (!context || typeof context !== "object") return null;
  if (context.elevationAvailable === false) {
    return null;
  }
  if (context.privilegeElevationSupported === false) {
    return null;
  }
  const suggestedGrants = Array.isArray(context.suggestedGrants)
    ? context.suggestedGrants as PrivilegeElevationGrantResource[]
    : null;
  if (!suggestedGrants || suggestedGrants.length === 0) return null;

  const command = typeof context.command === "string"
    ? context.command
    : undefined;
  const binary = typeof context.binary === "string"
    ? context.binary
    : undefined;
  const requestTimeoutSec =
    typeof context.privilegeElevationRequestTimeoutSec === "number"
      ? context.privilegeElevationRequestTimeoutSec
      : undefined;

  return {
    grants: suggestedGrants,
    scope: "task",
    command,
    binary,
    expiresAt: requestTimeoutSec && requestTimeoutSec > 0
      ? new Date(Date.now() + requestTimeoutSec * 1000).toISOString()
      : undefined,
    prompt: result.error.recovery ??
      formatPrivilegeElevationPrompt({
        grants: suggestedGrants,
        scope: "task",
        tool: typeof context.tool === "string" ? context.tool : undefined,
        binary,
        command,
      }),
  };
}
