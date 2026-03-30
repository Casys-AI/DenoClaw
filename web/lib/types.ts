/** Dashboard API response types — mirrors broker/gateway endpoints. */

export interface MetricsSummary {
  totalAgents: number;
  totalLLMCalls: number;
  totalTokens: number;
  totalCostUsd: number;
  totalToolCalls: number;
  totalA2AMessages: number;
}

export interface AgentMetrics {
  agentId: string;
  llm: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    avgLatencyMs: number;
  };
  tools: {
    calls: number;
    successes: number;
    failures: number;
    avgLatencyMs: number;
  };
  a2a: {
    messagesSent: number;
    messagesReceived: number;
    peersContacted: string[];
  };
  lastActivity: string;
}

export interface ActiveTaskEntry {
  taskId: string;
  sessionId: string;
  traceId?: string;
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
  metrics?: AgentMetrics;
  instance?: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface TaskObservationEntry {
  taskId: string;
  from: string;
  to: string;
  message: string;
  status: string;
  result?: string;
  traceId?: string;
  timestamp: string;
}

export interface HealthResponse {
  status: string;
  channels?: Record<string, unknown>;
  sessions?: number;
  tunnels?: string[];
  tunnelCount?: number;
}

export interface FederationLinkStats {
  linkId: string;
  remoteBrokerId: string;
  successCount: number;
  errorCount: number;
  denials: {
    policy: number;
    auth: number;
    notFound: number;
  };
  p50LatencyMs: number;
  p95LatencyMs: number;
  lastTaskId?: string;
  lastTraceId?: string;
  lastOccurredAt?: string;
}

export interface FederationStatsSnapshot {
  links: FederationLinkStats[];
  successCount: number;
  errorCount: number;
  denials: {
    policy: number;
    auth: number;
    notFound: number;
  };
  deadLetterBacklog: number;
}

export interface FederationDeadLetterTask {
  targetAgent: string;
  taskId: string;
  contextId: string;
  taskMessage?: Record<string, unknown>;
  message?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface FederationDeadLetterEntry {
  deadLetterId: string;
  idempotencyKey: string;
  remoteBrokerId: string;
  taskId: string;
  contextId: string;
  linkId: string;
  traceId: string;
  task: FederationDeadLetterTask;
  payloadHash: string;
  attempts: number;
  reason: string;
  movedAt: string;
}

export interface FederationReplayDeadLetterResult {
  status: "forwarded" | "deduplicated" | "dead_letter";
  idempotencyKey: string;
  attempts: number;
}

export interface FederationReplayDeadLetterResponse {
  ok: true;
  result: FederationReplayDeadLetterResult;
}
