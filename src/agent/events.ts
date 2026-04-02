import type { AgentConfig } from "./types.ts";
import type {
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";

// ── Base ─────────────────────────────────────────────

interface BaseEvent {
  eventId: number;
  timestamp: number;
  iterationId: number;
}

// ── Request events (kernel yields, middleware resolves) ──

export interface LlmRequestEvent extends BaseEvent {
  type: "llm_request";
  /** Messages snapshot at kernel yield time. May be stale if context was refreshed by middleware.
   *  The llmMiddleware uses getMessages() fresh — this field is for event store auditing only. */
  messages: Message[];
  tools: ToolDefinition[];
  config: AgentConfig;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Reserved — not yet emitted by agentKernel. */
export interface ConfirmationRequestEvent extends BaseEvent {
  type: "confirmation_request";
  callId: string;
  toolName: string;
  confirmationType: "boolean" | "structured";
  prompt: string;
  schema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Reserved — not yet emitted by agentKernel. */
export interface DelegationEvent extends BaseEvent {
  type: "delegation";
  targetAgent: string;
  message: string;
}

// ── Observation events (kernel ignores resolution; middlewares observe) ──

export interface LlmResponseEvent extends BaseEvent {
  type: "llm_response";
  content: string;
  toolCalls?: ToolCall[];
  usage?: LLMResponse["usage"];
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
}

export interface StateChangeEvent extends BaseEvent {
  type: "state_change";
  key: string;
  value: unknown;
}

// ── Terminal events (generator return) ──────────────

export interface CompleteEvent extends BaseEvent {
  type: "complete";
  content: string;
  finishReason?: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  code: string;
  context?: Record<string, unknown>;
  recovery?: string;
}

// ── Unions ───────────────────────────────────────────

export type AgentEvent =
  | LlmRequestEvent
  | LlmResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | ConfirmationRequestEvent
  | StateChangeEvent
  | DelegationEvent
  | CompleteEvent
  | ErrorEvent;

export type FinalEvent = CompleteEvent | ErrorEvent;

// ── Resolution types ────────────────────────────────

export interface LlmResolution {
  type: "llm";
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: LLMResponse["usage"];
}

export interface ToolResolution {
  type: "tool";
  result: ToolResult;
}

export interface ConfirmationResolution {
  type: "confirmation";
  confirmed: boolean;
  data?: Record<string, unknown>;
}

export interface DelegationResolution {
  type: "delegation";
  result: string;
}

export type EventResolution =
  | LlmResolution
  | ToolResolution
  | ConfirmationResolution
  | DelegationResolution;

// ── Factory ─────────────────────────────────────────

/** Distributive Omit — preserves discriminated union members. */
type DistributiveOmit<T, K extends keyof T> = T extends T ? Omit<T, K> : never;

export function createEventFactory(): <E extends AgentEvent>(
  body: DistributiveOmit<E, "eventId" | "timestamp" | "iterationId">,
  iterationId: number,
) => E {
  let seq = 0;
  return <E extends AgentEvent>(
    body: DistributiveOmit<E, "eventId" | "timestamp" | "iterationId">,
    iterationId: number,
  ): E => {
    return {
      ...body,
      eventId: seq++,
      timestamp: Date.now(),
      iterationId,
    } as unknown as E;
  };
}

// ── Utility ─────────────────────────────────────────

export function formatToolResultContent(result: ToolResult): string {
  if (result.success) return result.output;
  return `Error [${result.error?.code}]: ${
    JSON.stringify(result.error?.context)
  }\nRecovery: ${result.error?.recovery ?? "none"}`;
}
