import type { TaskStatus } from "./types.ts";
import type {
  PrivilegeElevationGrantResource,
  PrivilegeElevationScope,
} from "../../shared/privilege_elevation.ts";

export const AWAITED_INPUT_METADATA_KEY = "awaitedInput";
export const RESUME_PAYLOAD_METADATA_KEY = "resume";

export interface ClarificationField {
  key: string;
  label: string;
  required?: boolean;
}

export interface PrivilegeElevationAwaitedInput {
  kind: "privilege-elevation";
  grants: PrivilegeElevationGrantResource[];
  scope: PrivilegeElevationScope;
  prompt?: string;
  command?: string;
  binary?: string;
  pendingTool?: {
    tool: string;
    args: Record<string, unknown>;
    toolCallId?: string;
  };
  expiresAt?: string;
  continuationToken?: string;
}

export interface ClarificationAwaitedInput {
  kind: "clarification";
  question: string;
  fields?: ClarificationField[];
  continuationToken?: string;
}

export interface ConfirmationAwaitedInput {
  kind: "confirmation";
  prompt: string;
  destructive?: boolean;
  continuationToken?: string;
}

export type AwaitedInputMetadata =
  | PrivilegeElevationAwaitedInput
  | ClarificationAwaitedInput
  | ConfirmationAwaitedInput;

export interface ResumePayloadMetadata {
  continuationToken?: string;
  kind: AwaitedInputMetadata["kind"];
  approved?: boolean;
  grants?: PrivilegeElevationGrantResource[];
  scope?: PrivilegeElevationScope;
  responseText?: string;
  fields?: Record<string, unknown>;
}

export function createAwaitedInputMetadata(
  awaitedInput: AwaitedInputMetadata,
): Record<string, unknown> {
  return {
    [AWAITED_INPUT_METADATA_KEY]: awaitedInput,
  };
}

export function getAwaitedInputMetadata(
  source: Pick<TaskStatus, "metadata">,
): AwaitedInputMetadata | undefined {
  const value = source.metadata?.[AWAITED_INPUT_METADATA_KEY];
  return isAwaitedInputMetadata(value) ? value : undefined;
}

export function getAwaitedPrivilegeElevationPendingTool(
  source: Pick<TaskStatus, "metadata">,
): PrivilegeElevationAwaitedInput["pendingTool"] | undefined {
  const awaitedInput = getAwaitedInputMetadata(source);
  if (awaitedInput?.kind !== "privilege-elevation") return undefined;
  const pendingTool = awaitedInput.pendingTool;
  if (!isRecord(pendingTool) || typeof pendingTool.tool !== "string") {
    return undefined;
  }
  if (!isRecord(pendingTool.args)) return undefined;
  if (
    pendingTool.toolCallId !== undefined &&
    typeof pendingTool.toolCallId !== "string"
  ) {
    return undefined;
  }
  return {
    tool: pendingTool.tool,
    args: pendingTool.args,
    ...(pendingTool.toolCallId ? { toolCallId: pendingTool.toolCallId } : {}),
  };
}

export function createResumePayloadMetadata(
  resume: ResumePayloadMetadata,
): Record<string, unknown> {
  return {
    [RESUME_PAYLOAD_METADATA_KEY]: resume,
  };
}

export function getResumePayloadMetadata(
  source: Pick<TaskStatus, "metadata">,
): ResumePayloadMetadata | undefined {
  const value = source.metadata?.[RESUME_PAYLOAD_METADATA_KEY];
  return isResumePayloadMetadata(value) ? value : undefined;
}

function isAwaitedInputMetadata(value: unknown): value is AwaitedInputMetadata {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "privilege-elevation":
      return Array.isArray(value.grants) && typeof value.scope === "string";
    case "clarification":
      return typeof value.question === "string";
    case "confirmation":
      return typeof value.prompt === "string";
    default:
      return false;
  }
}

function isResumePayloadMetadata(
  value: unknown,
): value is ResumePayloadMetadata {
  return isRecord(value) && typeof value.kind === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
