/**
 * Internal local-runtime → canonical A2A mapping helpers.
 *
 * This module is intentionally a narrow compatibility bridge. It maps worker
 * protocol inputs and local runtime outcomes into canonical A2A task shapes,
 * but lifecycle rules remain centralized in `internal_contract.ts`.
 */
import type { WorkerRequest } from "../../agent/worker_protocol.ts";
import { AgentError, DenoClawError } from "../../shared/errors.ts";
import {
  classifyRefusalTerminalState,
  createCanonicalTask,
} from "./internal_contract.ts";
import { createAwaitedInputMetadata } from "./input_metadata.ts";
import type { A2AMessage, Artifact, Task } from "./types.ts";

type LocalProcessRequest = Extract<WorkerRequest, { type: "process" }>;

type LocalTextInput = Pick<
  LocalProcessRequest,
  "requestId" | "sessionId" | "message" | "taskId" | "contextId"
> & {
  role?: A2AMessage["role"];
};

export interface ApprovalPauseInput {
  command: string;
  binary: string;
  prompt?: string;
  continuationToken?: string;
}

export function resolveTaskIdFromRequestId(requestId: string): string {
  return requestId;
}

export function resolveContextIdFromSessionId(sessionId: string): string {
  return sessionId;
}

export function mapLocalTextInputToTask(input: LocalTextInput): Task {
  const taskId = input.taskId ?? resolveTaskIdFromRequestId(input.requestId);
  const contextId = input.contextId ?? resolveContextIdFromSessionId(input.sessionId);

  return createCanonicalTask({
    id: taskId,
    contextId,
    message: createTextMessage(input.message, input.role ?? "user"),
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

  return {
    ...task,
    artifacts: [...task.artifacts, artifact],
    status: {
      state: "COMPLETED",
      timestamp: new Date().toISOString(),
      message: createTextMessage(content, "agent"),
    },
  };
}

export function mapTaskErrorToTerminalStatus(task: Task, error: unknown): Task {
  const normalized = normalizeTaskError(error);
  const state = classifyRefusalTerminalState(normalized.reason);

  return {
    ...task,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: createTextMessage(normalized.message, "agent"),
      metadata: {
        errorCode: normalized.code,
        ...(normalized.context ? { errorContext: normalized.context } : {}),
      },
    },
  };
}

export function mapApprovalPauseToInputRequiredTask(
  task: Task,
  approval: ApprovalPauseInput,
): Task {
  return {
    ...task,
    status: {
      state: "INPUT_REQUIRED",
      timestamp: new Date().toISOString(),
      message: createTextMessage(
        approval.prompt ?? `Awaiting approval for ${approval.binary}`,
        "agent",
      ),
      metadata: createAwaitedInputMetadata({
        kind: "approval",
        command: approval.command,
        binary: approval.binary,
        prompt: approval.prompt,
        continuationToken: approval.continuationToken,
      }),
    },
  };
}

function createTextMessage(text: string, role: A2AMessage["role"]): A2AMessage {
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
  if (code.includes("POLICY") || code.includes("ALLOWLIST") || code.includes("DENIED")) {
    return "policy";
  }
  if (code.length > 0) return "runtime";
  return "unknown";
}
