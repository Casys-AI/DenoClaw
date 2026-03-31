import { getAwaitedInputMetadata } from "../../messaging/a2a/input_metadata.ts";
import type { Part, Task } from "../../messaging/a2a/types.ts";
import { formatPrivilegeElevationPrompt } from "../../shared/privilege_elevation.ts";

export function getChannelTaskResponseText(task: Task): string | null {
  for (const artifact of [...task.artifacts].reverse()) {
    const text = extractTextPart(artifact.parts);
    if (text) return text;
  }

  const statusText = extractTextPart(task.status.message?.parts);
  if (statusText) return statusText;

  const awaitedInput = getAwaitedInputMetadata(task.status);
  if (!awaitedInput) return null;
  switch (awaitedInput.kind) {
    case "privilege-elevation":
      return awaitedInput.prompt ??
        formatPrivilegeElevationPrompt({
          grants: awaitedInput.grants,
          scope: awaitedInput.scope,
          tool: awaitedInput.binary ?? awaitedInput.command,
          binary: awaitedInput.binary,
          command: awaitedInput.command,
        });
    case "clarification":
      return awaitedInput.question;
    case "confirmation":
      return awaitedInput.prompt;
  }

  return null;
}

function extractTextPart(parts?: Part[]): string | null {
  if (!parts) return null;
  for (const part of parts) {
    if (part.kind === "text") return part.text;
  }
  return null;
}
