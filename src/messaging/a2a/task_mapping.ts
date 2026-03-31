/**
 * Runtime → canonical A2A task mapping helpers.
 *
 * Maps runtime inputs (text messages, errors, privilege elevation pauses) into canonical
 * A2A task shapes. Lifecycle rules remain centralized in `internal_contract.ts`.
 *
 * This module has no dependency on agent/ or orchestration/ — it only uses
 * shared types and A2A primitives.
 */
import { AgentError, DenoClawError } from "../../shared/errors.ts";
import {
  classifyRefusalTerminalState,
  createCanonicalTask,
  transitionTask,
} from "./internal_contract.ts";
import { createAwaitedInputMetadata } from "./input_metadata.ts";
import type { A2AMessage, Artifact, Task } from "./types.ts";
import type {
  PrivilegeElevationGrantResource,
  PrivilegeElevationScope,
} from "../../shared/privilege_elevation.ts";
import {
  formatPrivilegeElevationPrompt,
} from "../../shared/privilege_elevation.ts";

export interface TaskTextInput {
  requestId: string;
  sessionId: string;
  message: string;
  taskId?: string;
  contextId?: string;
  role?: A2AMessage["role"];
}

export interface PrivilegeElevationPauseInput {
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

export function resolveTaskIdFromRequestId(requestId: string): string {
  return requestId;
}

export function resolveContextIdFromSessionId(sessionId: string): string {
  return sessionId;
}

export function mapLocalTextInputToTask(input: TaskTextInput): Task {
  const taskId = input.taskId ?? resolveTaskIdFromRequestId(input.requestId);
  const contextId = input.contextId ??
    resolveContextIdFromSessionId(input.sessionId);

  return createCanonicalTask({
    id: taskId,
    contextId,
    initialMessage: createTextMessage(input.message, input.role ?? "user"),
    metadata: {
      localRuntime: {
        requestId: input.requestId,
        sessionId: input.sessionId,
      },
    },
  });
}

export function mapTaskResultToCompletion(
  task: Task,
  content: string,
  artifactName = "result",
): Task {
  const artifact: Artifact = {
    artifactId: `${task.id}:result`,
    name: artifactName,
    parts: [{ kind: "text", text: content }],
  };

  const withArtifact = {
    ...task,
    artifacts: [...task.artifacts, artifact],
  };

  return transitionTask(withArtifact, "COMPLETED", {
    statusMessage: createTextMessage(content, "agent"),
  });
}

export function mapTaskErrorToTerminalStatus(
  task: Task,
  error: unknown,
): Task {
  const normalized = normalizeTaskError(error);
  const state = classifyRefusalTerminalState(normalized.reason);

  return transitionTask(task, state, {
    statusMessage: createTextMessage(normalized.message, "agent"),
    metadata: {
      errorCode: normalized.code,
      ...(normalized.context ? { errorContext: normalized.context } : {}),
    },
  });
}

export function mapPrivilegeElevationPauseToInputRequiredTask(
  task: Task,
  elevation: PrivilegeElevationPauseInput,
): Task {
  return transitionTask(task, "INPUT_REQUIRED", {
    statusMessage: createTextMessage(
      elevation.prompt ?? formatPrivilegeElevationPrompt({
        grants: elevation.grants,
        scope: elevation.scope,
        tool: elevation.binary ?? elevation.command,
        binary: elevation.binary,
        command: elevation.command,
      }),
      "agent",
    ),
    metadata: createAwaitedInputMetadata({
      kind: "privilege-elevation",
      grants: elevation.grants,
      scope: elevation.scope,
      ...(elevation.prompt !== undefined ? { prompt: elevation.prompt } : {}),
      ...(elevation.command !== undefined
        ? { command: elevation.command }
        : {}),
      ...(elevation.binary !== undefined ? { binary: elevation.binary } : {}),
      ...(elevation.pendingTool !== undefined
        ? { pendingTool: elevation.pendingTool }
        : {}),
      ...(elevation.expiresAt !== undefined
        ? { expiresAt: elevation.expiresAt }
        : {}),
      ...(elevation.continuationToken !== undefined
        ? { continuationToken: elevation.continuationToken }
        : {}),
    }),
  });
}

function createTextMessage(
  text: string,
  role: A2AMessage["role"],
): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role,
    parts: [{ kind: "text", text }],
  };
}

function normalizeTaskError(error: unknown): {
  code: string;
  message: string;
  context?: Record<string, unknown>;
  reason: "user" | "policy" | "runtime" | "unknown";
} {
  if (error instanceof DenoClawError || error instanceof AgentError) {
    return {
      code: error.code,
      message: error.recovery ?? error.message,
      context: error.context,
      reason: classifyErrorReason(error.code),
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNEXPECTED_ERROR",
      message: error.message,
      reason: "runtime",
    };
  }

  return {
    code: "UNEXPECTED_ERROR",
    message: String(error),
    reason: "unknown",
  };
}

function classifyErrorReason(
  code: string,
): "user" | "policy" | "runtime" | "unknown" {
  if (code.includes("USER_DENIED") || code.includes("REJECTED_BY_USER")) {
    return "user";
  }
  if (
    code.includes("POLICY") || code.includes("ALLOWLIST") ||
    code.includes("DENIED")
  ) {
    return "policy";
  }
  if (code.length > 0) return "runtime";
  return "unknown";
}
