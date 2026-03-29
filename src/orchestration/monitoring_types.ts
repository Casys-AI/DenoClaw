/**
 * Orchestration monitoring/read-model contracts.
 */

export interface AgentStatusValue {
  status: "running" | "alive" | "stopped";
  startedAt?: string;
  lastHeartbeat?: string;
  stoppedAt?: string;
  model?: string;
}

export interface ActiveTaskEntry {
  taskId: string;
  sessionId: string;
  traceId?: string;
  contextId?: string;
  startedAt: string;
}

export interface AgentStatusEntry {
  agentId: string;
  status: "running" | "alive" | "stopped";
  startedAt?: string;
  lastHeartbeat?: string;
  stoppedAt?: string;
  model?: string;
  activeTask?: ActiveTaskEntry | null;
}

export interface TaskObservationEntry {
  taskId: string;
  from: string;
  to: string;
  message: string;
  status: string;
  result?: string;
  traceId?: string;
  contextId?: string;
  timestamp: string;
}
