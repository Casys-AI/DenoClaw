// Contracts related to broker messaging, tool execution and agent runtime ports.

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface StructuredError {
  code: string;
  context?: Record<string, unknown>;
  recovery?: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: StructuredError;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Message envelope for broker-routed communication. */
export interface BrokerEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  id: string;
  from: string;
  to: string;
  type: TType;
  payload: TPayload;
  timestamp: string;
}

/**
 * Broker access port for agents (DI).
 * The agent depends on this interface, not the concrete BrokerClient.
 */
export interface AgentBrokerPort {
  startListening(): Promise<void>;
  complete(
    messages: Message[],
    model: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse>;
  execTool(
    tool: string,
    args: Record<string, unknown>,
    correlation?: { taskId?: string; contextId?: string },
  ): Promise<ToolResult>;
  close(): void;
}
