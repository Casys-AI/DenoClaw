import type {
  AgentConfig,
  AgentDefaults,
  AgentResponse,
  ToolsConfig,
} from "./types.ts";
import type { SandboxConfig } from "../shared/types.ts";
import type { ProvidersConfig } from "../llm/types.ts";
import { ProviderManager } from "../llm/manager.ts";
import { createSandboxBackend } from "./tools/backends/factory.ts";

/** Minimal Config projection required by AgentLoop — no dependency on config/. */
interface AgentLoopConfig {
  agents: { defaults: AgentDefaults };
  providers: ProvidersConfig;
  tools?: ToolsConfig;
}
import { Memory } from "./memory.ts";
import type { MemoryPort } from "./memory_port.ts";
import { ContextBuilder } from "./context.ts";
import { SkillsLoader } from "./skills.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ShellTool } from "./tools/shell.ts";
import { ReadFileTool, WriteFileTool } from "./tools/file.ts";
import type { WorkspaceContext } from "./tools/file.ts";
import { WebFetchTool } from "./tools/web.ts";
import { SendToAgentTool } from "./tools/send_to_agent.ts";
import type { SendToAgentFn } from "./tools/send_to_agent.ts";
import { MemoryTool } from "./tools/memory.ts";
import type { TraceWriter } from "../telemetry/traces.ts";
import { processAgentLoopMessage } from "./loop_process.ts";
import { listAgentMemoryFiles } from "./loop_workspace.ts";

import type { ApprovalRequest, ApprovalResponse } from "./sandbox_types.ts";

export type AskApprovalFn = (req: ApprovalRequest) => Promise<ApprovalResponse>;

export interface AgentLoopLike {
  processMessage(userMessage: string): Promise<AgentResponse>;
  close(): Promise<void>;
}

export interface AgentLoopFactoryContext {
  sessionId: string;
  model?: string;
  traceId?: string;
  taskId: string;
  contextId: string;
  askApproval?: AskApprovalFn;
}

export interface AgentLoopDeps {
  providers?: ProviderManager;
  memory?: MemoryPort;
  tools?: ToolRegistry;
  sendToAgent?: SendToAgentFn;
  availablePeers?: string[];
  sandboxConfig?: SandboxConfig;
  askApproval?: AskApprovalFn;
  traceWriter?: TraceWriter;
  traceId?: string;
  taskId?: string;
  contextId?: string;
  agentId?: string;
  workspaceDir?: string;
  workspaceKv?: Deno.Kv;
}

export class AgentLoop implements AgentLoopLike {
  private config: AgentConfig;
  private providers: ProviderManager;
  private memory: MemoryPort;
  private context: ContextBuilder;
  private skills: SkillsLoader;
  private tools: ToolRegistry;
  private maxIterations: number;
  private traceWriter: TraceWriter | null;
  private traceId: string | undefined;
  private taskId: string | undefined;
  private contextId: string | undefined;
  private agentId: string;
  private sessionId: string;
  private workspaceDir: string | undefined;
  private memoryFiles: string[] = [];

  constructor(
    sessionId: string,
    config: AgentLoopConfig,
    agentConfig?: Partial<AgentConfig>,
    maxIterations = 10,
    deps?: AgentLoopDeps,
  ) {
    this.config = {
      model: config.agents?.defaults?.model || "anthropic/claude-sonnet-4-6",
      temperature: config.agents?.defaults?.temperature ?? 0.7,
      maxTokens: config.agents?.defaults?.maxTokens ?? 4096,
      systemPrompt: config.agents?.defaults?.systemPrompt,
      ...agentConfig,
    };

    this.providers = deps?.providers ?? new ProviderManager(config.providers);
    this.memory = deps?.memory ?? new Memory(sessionId);
    this.tools = deps?.tools ?? new ToolRegistry();
    this.context = new ContextBuilder(this.config);
    this.skills = new SkillsLoader();
    this.maxIterations = maxIterations;
    this.traceWriter = deps?.traceWriter ?? null;
    this.traceId = deps?.traceId;
    this.taskId = deps?.taskId;
    this.contextId = deps?.contextId ?? deps?.taskId;
    this.agentId = deps?.agentId ?? sessionId;
    this.sessionId = sessionId;
    this.workspaceDir = deps?.workspaceDir;

    if (!deps?.tools) this.registerBuiltInTools(config, deps);
    if (deps?.sendToAgent) {
      this.tools.register(
        new SendToAgentTool(deps.sendToAgent, deps.availablePeers),
      );
    }
    this.tools.register(new MemoryTool(this.memory));
    if (deps?.sandboxConfig) {
      const backend = createSandboxBackend(deps.sandboxConfig);
      const toolsCfg = {
        ...config.tools,
        workspaceDir: deps.workspaceDir,
        agentId: this.agentId,
      };
      this.tools.setBackend(
        backend,
        deps.sandboxConfig.execPolicy,
        toolsCfg,
        deps.sandboxConfig.networkAllow,
      );
      if (deps.askApproval) this.tools.setAskApproval(deps.askApproval);
    }
  }

  private registerBuiltInTools(
    config: AgentLoopConfig,
    deps?: AgentLoopDeps,
  ): void {
    const t = config.tools;
    this.tools.register(new ShellTool(t?.restrictToWorkspace));
    const wsCtx: WorkspaceContext | undefined = deps?.workspaceDir
      ? {
        workspaceDir: deps.workspaceDir,
        agentId: this.agentId,
        kv: deps.workspaceKv,
      }
      : undefined;
    this.tools.register(new ReadFileTool(wsCtx));
    this.tools.register(new WriteFileTool(wsCtx));
    this.tools.register(new WebFetchTool());
  }

  private memoryTopics: string[] = [];

  async initialize(): Promise<void> {
    await this.memory.load();
    await this.skills.loadSkills();
    this.memoryTopics = await this.memory.listTopics();
    if (this.workspaceDir) {
      this.memoryFiles = await listAgentMemoryFiles(this.workspaceDir);
    }
  }

  async processMessage(userMessage: string): Promise<AgentResponse> {
    await this.initialize();
    return await processAgentLoopMessage({
      userMessage,
      config: this.config,
      providers: this.providers,
      memory: this.memory,
      context: this.context,
      skills: this.skills,
      tools: this.tools,
      memoryTopics: this.memoryTopics,
      memoryFiles: this.memoryFiles,
      maxIterations: this.maxIterations,
      traceWriter: this.traceWriter,
      traceId: this.traceId,
      taskId: this.taskId,
      contextId: this.contextId,
      agentId: this.agentId,
      sessionId: this.sessionId,
    });
  }

  getMemory(): MemoryPort {
    return this.memory;
  }

  getTools(): ToolRegistry {
    return this.tools;
  }

  async close(): Promise<void> {
    await this.tools.close();
    this.memory.close();
  }
}
