/**
 * A2A (Agent-to-Agent) Protocol types — v1.0
 * Spec: https://a2a-protocol.org/latest/specification/
 */

// ── Agent Card ───────────────────────────────────────────

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  protocolVersion: "1.0";
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  authentication?: {
    schemes: string[];
  };
  skills: AgentSkill[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

// ── Task lifecycle ───────────────────────────────────────

export type TaskState =
  | "SUBMITTED"
  | "WORKING"
  | "INPUT_REQUIRED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "REJECTED";

export const TERMINAL_STATES: TaskState[] = [
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "REJECTED",
];

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts: Artifact[];
  history: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ── Messages & Parts ─────────────────────────────────────

export type A2ARole = "user" | "agent";

export interface A2AMessage {
  messageId: string;
  role: A2ARole;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface TextPart {
  kind: "text";
  text: string;
}

export interface FilePart {
  kind: "file";
  name: string;
  mimeType: string;
  data: string; // base64
}

export interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
}

// ── Artifacts ────────────────────────────────────────────

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: Part[];
}

// ── JSON-RPC 2.0 ────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: A2AMethod;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type A2AMethod =
  | "message/send"
  | "message/stream"
  | "tasks/get"
  | "tasks/cancel"
  | "tasks/pushNotificationConfig/set"
  | "tasks/pushNotificationConfig/get";

// ── SSE events ───────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  kind: "taskStatusUpdate";
  taskId: string;
  status: TaskStatus;
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  kind: "artifactUpdate";
  taskId: string;
  artifact: Artifact;
}

// ── A2A error codes ──────────────────────────────────────

export const A2A_ERRORS = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_INCOMPATIBLE: -32005,
} as const;
