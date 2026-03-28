import type { TaskStatus } from "./types.ts";

export const AWAITED_INPUT_METADATA_KEY = "awaitedInput";
export const RESUME_PAYLOAD_METADATA_KEY = "resume";

export interface ClarificationField {
  key: string;
  label: string;
  required?: boolean;
}

export interface ApprovalAwaitedInput {
  kind: "approval";
  command?: string;
  binary?: string;
  prompt?: string;
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
  | ApprovalAwaitedInput
  | ClarificationAwaitedInput
  | ConfirmationAwaitedInput;

export interface ResumePayloadMetadata {
  continuationToken?: string;
  kind: AwaitedInputMetadata["kind"];
  approved?: boolean;
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
    case "approval":
      return true;
    case "clarification":
      return typeof value.question === "string";
    case "confirmation":
      return typeof value.prompt === "string";
    default:
      return false;
  }
}

function isResumePayloadMetadata(value: unknown): value is ResumePayloadMetadata {
  return isRecord(value) && typeof value.kind === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
