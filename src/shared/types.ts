/**
 * Shared Kernel facade (temporary compatibility layer).
 *
 * Migration note:
 * - Canonical contracts now live under `src/shared/contracts/*`.
 * - This file is kept for backward compatibility and should be removed once
 *   all imports switch to `src/shared/mod.ts` or direct contract modules.
 *
 * Contribution rule:
 * - A type enters `shared` only if it is consumed by at least 3 contexts,
 *   or if it represents a stable inter-boundary contract.
 */

export type {
  AgentBrokerPort,
  BrokerEnvelope,
  LLMResponse,
  Message,
  MessageRole,
  StructuredError,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./contracts/broker.ts";

export type { AgentEntry, ChannelRouting } from "./contracts/agent_registry.ts";

export type {
  ApprovalReason,
  ApprovalRequest,
  ApprovalResponse,
  ExecPolicy,
  SandboxBackend,
  SandboxConfig,
  SandboxExecRequest,
  SandboxPermission,
} from "./contracts/sandbox.ts";

export type {
  ActiveTaskEntry,
  AgentStatusEntry,
  AgentStatusValue,
  TaskObservationEntry,
} from "./contracts/observability.ts";
