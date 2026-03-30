import type { A2AMessage } from "../messaging/a2a/types.ts";
import type { ToolResult } from "../shared/types.ts";
import type { ApprovalReason } from "./sandbox_types.ts";

export interface RuntimeApprovalPause {
  command: string;
  binary: string;
  reason: ApprovalReason;
  prompt: string;
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

export function extractRuntimeApprovalPause(
  result: ToolResult,
): RuntimeApprovalPause | null {
  if (result.success || result.error?.code !== "EXEC_APPROVAL_REQUIRED") {
    return null;
  }

  const context = result.error.context;
  if (!context || typeof context !== "object") return null;

  const command = typeof context.command === "string" ? context.command : null;
  const binary = typeof context.binary === "string" ? context.binary : null;
  const reason = typeof context.reason === "string"
    ? context.reason as ApprovalReason
    : null;
  if (!command || !binary || !reason) return null;

  return {
    command,
    binary,
    reason,
    prompt: `Awaiting approval for ${binary}: ${command}`,
  };
}
