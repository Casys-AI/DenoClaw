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

export interface ToolMetrics {
  tool: string;
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
}

export interface HourlyBucket {
  hour: string;
  provider: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface HourlyA2ABucket {
  hour: string;
  sent: number;
  received: number;
}

export interface A2AFrequencyEntry {
  fromAgent: string;
  toAgent: string;
  totalCalls: number;
  hourlyBreakdown: { hour: string; calls: number }[];
}

export interface HourlyToolBucket {
  hour: string;
  tool: string;
  calls: number;
}
