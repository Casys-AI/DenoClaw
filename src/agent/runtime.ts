import type {
  AgentCanonicalTaskPort,
  AgentLlmToolPort,
  BrokerEnvelope,
} from "../shared/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import type { AgentConfig } from "./types.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { Task } from "../messaging/a2a/types.ts";
import {
  extractContinuationTaskMessage,
  extractSubmitTaskMessage,
} from "./runtime_transport.ts";
import {
  createCanonicalTask,
  transitionTask,
} from "../messaging/a2a/internal_contract.ts";
import { mapTaskErrorToTerminalStatus } from "../messaging/a2a/task_mapping.ts";
import { createMemory } from "./memory_factory.ts";
import { ContextBuilder } from "./context.ts";
import type { SkillLoader } from "./skills.ts";
import { KvSkillsLoader, SkillsLoader } from "./skills.ts";
import { log } from "../shared/log.ts";
import {
  assertRuntimeTaskMessage,
  type RuntimeTaskContinueMessage,
  type RuntimeTaskSubmitMessage,
} from "./runtime_transport.ts";
import { createBrokerRunner } from "./runner.ts";
import { PrivilegeElevationPause } from "./middlewares/a2a_task.ts";
import {
  extractApprovedPrivilegeElevationGrant,
  extractRuntimeTaskText,
} from "./runtime_message_mapping.ts";
import type { AgentRuntimeCapabilities } from "./runtime_capabilities.ts";
import { AgentRuntimeGrantStore } from "./runtime_capabilities.ts";
import type { ToolDefinition } from "../shared/types.ts";
import { createBrokerBackedRuntimeToolDefinitions } from "./runtime_tool_definitions.ts";
import {
  getAwaitedPrivilegeElevationPendingTool,
} from "../messaging/a2a/input_metadata.ts";
import {
  mapPrivilegeElevationPauseToInputRequiredTask,
} from "../messaging/a2a/task_mapping.ts";
import {
  extractRuntimePrivilegeElevationPause,
} from "./runtime_message_mapping.ts";
import {
  getAgentDefDir,
  getAgentSkillsDir,
  isDeployEnvironment,
} from "../shared/helpers.ts";
import { listAgentMemoryFiles } from "./loop_workspace.ts";

/**
 * AgentRuntime — runs inside a deployed agent app or local worker.
 *
 * Task-oriented runtime:
 * - Receives work via handleIncomingMessage() (transport-agnostic)
 * - Calls LLM via AgentBrokerPort (never directly)
 * - Dispatches tool execution to Sandbox (via AgentBrokerPort)
 * - Persists state via MemoryPort (KvdexMemory by default)
 *
 * Transport is decided by the caller. The runtime does not assume any
 * specific delivery mechanism.
 */

export class AgentRuntime {
  private agentId: string;
  private config: AgentConfig;
  private llmToolPort: AgentLlmToolPort;
  private canonicalTaskPort: AgentCanonicalTaskPort<Task>;
  private kv: Deno.Kv | null = null;
  private context: ContextBuilder;
  private skills: SkillLoader;
  private maxIterations: number;
  private memories: Map<string, MemoryPort> = new Map();
  private toolDefinitions: ToolDefinition[];
  private memoryFiles: string[] = [];

  constructor(
    agentId: string,
    config: AgentConfig,
    llmToolPort: AgentLlmToolPort,
    canonicalTaskPort: AgentCanonicalTaskPort<Task>,
    maxIterations = 10,
    runtimeCapabilities?: AgentRuntimeCapabilities,
  ) {
    this.agentId = agentId;
    this.config = config;
    this.llmToolPort = llmToolPort;
    this.canonicalTaskPort = canonicalTaskPort;
    this.context = new ContextBuilder(config, runtimeCapabilities);
    this.skills = new SkillsLoader(getAgentSkillsDir(agentId));
    this.maxIterations = maxIterations;
    this.toolDefinitions = createBrokerBackedRuntimeToolDefinitions();
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  private async getMemory(sessionId: string): Promise<MemoryPort> {
    let mem = this.memories.get(sessionId);
    if (!mem) {
      mem = await createMemory(this.agentId, sessionId);
      this.memories.set(sessionId, mem);
    }
    return mem;
  }

  async start(): Promise<void> {
    log.info(`AgentRuntime started: ${this.agentId}`);

    this.skills = await this.createSkillsLoader();
    await this.skills.loadSkills();
    await this.llmToolPort.startListening();
  }

  private async createSkillsLoader(): Promise<SkillLoader> {
    if (isDeployEnvironment()) {
      return new KvSkillsLoader(await this.getKv(), this.agentId);
    }

    return new SkillsLoader(getAgentSkillsDir(this.agentId));
  }

  private async loadMemoryFiles(): Promise<string[]> {
    if (isDeployEnvironment()) {
      return await listAgentMemoryFiles({
        agentId: this.agentId,
        kv: await this.getKv(),
        useWorkspaceKv: true,
      });
    }

    return await listAgentMemoryFiles({
      agentId: this.agentId,
      workspaceDir: getAgentDefDir(this.agentId),
      useWorkspaceKv: false,
    });
  }

  /**
   * Handle an incoming broker message (transport-agnostic).
   * Called by the runtime-specific transport layer.
   */
  async handleIncomingMessage(msg: BrokerEnvelope): Promise<void> {
    assertRuntimeTaskMessage(msg);

    try {
      switch (msg.type) {
        case "task_submit":
          await this.handleTaskSubmitMessage(msg);
          break;
        case "task_continue":
          await this.handleTaskContinueMessage(msg);
          break;
      }
    } catch (e) {
      log.error("handleIncomingMessage failed", e);
      const payload = msg.payload as { taskId?: string } | undefined;
      const taskId = payload?.taskId;
      if (taskId) {
        try {
          const existing = await this.canonicalTaskPort.getTask(taskId);
          if (existing) {
            const failed = mapTaskErrorToTerminalStatus(existing, e);
            await this.canonicalTaskPort.reportTaskResult(failed);
          }
        } catch (reportErr) {
          log.error(
            "Failed to report terminal FAILED state for task",
            reportErr,
          );
        }
      }
    }
  }

  private async handleTaskSubmitMessage(
    msg: RuntimeTaskSubmitMessage,
  ): Promise<void> {
    const payload = msg.payload;
    const taskMessage = extractSubmitTaskMessage(payload);
    const inputText = extractRuntimeTaskText(taskMessage);
    const memory = await this.getMemory(`agent:${msg.from}:${this.agentId}`);
    this.memoryFiles = await this.loadMemoryFiles();
    log.info(
      `Canonical task received from ${msg.from}: ${inputText.slice(0, 100)}`,
    );

    const canonicalTask = createCanonicalTask({
      id: payload.taskId,
      contextId: payload.contextId,
      initialMessage: taskMessage,
    });

    // Report WORKING transition
    const workingTask = transitionTask(canonicalTask, "WORKING");
    await this.reportCanonicalTaskResult(workingTask);

    // Add user message
    if (inputText.trim().length > 0) {
      await memory.addMessage({ role: "user", content: inputText });
    }

    const { runner, session, kernelInput } = createBrokerRunner({
      agentId: this.agentId,
      canonicalTask: workingTask,
      memoryFiles: this.memoryFiles,
      memory,
      complete: (messages, model, temperature, maxTokens, tools) =>
        this.llmToolPort.complete(messages, model, temperature, maxTokens, tools),
      executeTool: (name, args) =>
        this.llmToolPort.execTool(name, args, {
          taskId: workingTask.id,
          contextId: workingTask.contextId,
        }),
      contextRefresh: {
        skills: this.skills,
        memory,
        refreshMemoryFiles: () => this.loadMemoryFiles(),
      },
      a2aTask: {
        reportTaskResult: (task) => this.reportCanonicalTaskResult(task),
      },
      buildMessages: async (memoryTopics, memoryFiles) =>
        this.context.buildContextMessages(
          await memory.getMessages(),
          this.skills.getSkills(),
          this.toolDefinitions,
          memoryTopics,
          memoryFiles,
        ),
      toolDefinitions: this.toolDefinitions,
      llmConfig: this.config,
      maxIterations: this.maxIterations,
    });
    session.memoryTopics = await memory.listTopics();

    try {
      await runner.run(kernelInput);
    } catch (e) {
      if (e instanceof PrivilegeElevationPause) return;
      throw e;
    }
  }

  private async handleTaskContinueMessage(
    msg: RuntimeTaskContinueMessage,
  ): Promise<void> {
    const payload = msg.payload;
    const continuationMessage = extractContinuationTaskMessage(payload);
    const existing = await this.canonicalTaskPort.getTask(payload.taskId);
    if (!existing) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: payload.taskId },
        "Broker-backed continuation received unknown task",
      );
    }

    const resumed = transitionTask(existing, "WORKING", {
      statusMessage: continuationMessage,
    });
    resumed.history = [...existing.history, continuationMessage];
    await this.reportCanonicalTaskResult(resumed);
    const inputText = extractRuntimeTaskText(continuationMessage);
    const runtimeGrantStore = new AgentRuntimeGrantStore();
    const approvedPrivilegeGrant = extractApprovedPrivilegeElevationGrant(
      existing,
      payload,
    );
    if (approvedPrivilegeGrant) {
      runtimeGrantStore.grantPrivilegeElevation({
        scope: approvedPrivilegeGrant.scope,
        grants: approvedPrivilegeGrant.grants,
        source: approvedPrivilegeGrant.source,
        grantedAt: approvedPrivilegeGrant.grantedAt,
      });
    }
    const pendingTool = approvedPrivilegeGrant
      ? getAwaitedPrivilegeElevationPendingTool(existing.status)
      : undefined;
    const memory = await this.getMemory(`agent:${msg.from}:${this.agentId}`);
    if (this.memoryFiles.length === 0) {
      this.memoryFiles = await this.loadMemoryFiles();
    }

    // Auto-retry pending tool if privilege was approved
    if (approvedPrivilegeGrant && pendingTool) {
      log.info(
        `Canonical continuation received from ${msg.from}: auto-retrying pending tool ${pendingTool.tool}`,
      );
      const result = await this.llmToolPort.execTool(
        pendingTool.tool,
        pendingTool.args,
        { taskId: resumed.id, contextId: resumed.contextId },
      );
      const privilegePause = extractRuntimePrivilegeElevationPause(result);
      if (privilegePause) {
        await this.reportCanonicalTaskResult(
          mapPrivilegeElevationPauseToInputRequiredTask(resumed, {
            grants: privilegePause.grants,
            scope: privilegePause.scope,
            prompt: privilegePause.prompt,
            command: privilegePause.command,
            binary: privilegePause.binary,
            pendingTool,
            expiresAt: privilegePause.expiresAt,
          }),
        );
        log.info(
          `Canonical task paused again in INPUT_REQUIRED for privilege elevation (${msg.from})`,
        );
        return;
      }

      await memory.addMessage({
        role: "tool",
        content: result.success
          ? result.output
          : `Error [${result.error?.code}]: ${
            JSON.stringify(result.error?.context)
          }\nRecovery: ${result.error?.recovery ?? "none"}`,
        name: pendingTool.tool,
        ...(pendingTool.toolCallId
          ? { tool_call_id: pendingTool.toolCallId }
          : {}),
      });
    }

    // Add continuation input
    if (inputText.trim().length > 0) {
      await memory.addMessage({ role: "user", content: inputText });
    }

    log.info(
      `Canonical continuation received from ${msg.from}: ${inputText.slice(0, 100)}`,
    );

    const grants = runtimeGrantStore.list();
    const { runner, session, kernelInput } = createBrokerRunner({
      agentId: this.agentId,
      canonicalTask: resumed,
      memoryFiles: this.memoryFiles,
      runtimeGrants: grants,
      memory,
      complete: (messages, model, temperature, maxTokens, tools) =>
        this.llmToolPort.complete(messages, model, temperature, maxTokens, tools),
      executeTool: (name, args) =>
        this.llmToolPort.execTool(name, args, {
          taskId: resumed.id,
          contextId: resumed.contextId,
        }),
      contextRefresh: {
        skills: this.skills,
        memory,
        refreshMemoryFiles: () => this.loadMemoryFiles(),
      },
      a2aTask: {
        reportTaskResult: (task) => this.reportCanonicalTaskResult(task),
      },
      buildMessages: async (memoryTopics, memoryFiles) =>
        this.context.buildContextMessages(
          await memory.getMessages(),
          this.skills.getSkills(),
          this.toolDefinitions,
          memoryTopics,
          memoryFiles,
          grants,
        ),
      toolDefinitions: this.toolDefinitions,
      llmConfig: this.config,
      maxIterations: this.maxIterations,
    });
    session.memoryTopics = await memory.listTopics();

    try {
      await runner.run(kernelInput);
    } catch (e) {
      if (e instanceof PrivilegeElevationPause) return;
      throw e;
    }
  }

  private async reportCanonicalTaskResult(task: Task): Promise<void> {
    await this.canonicalTaskPort.reportTaskResult(task);
  }

  stop(): void {
    this.llmToolPort.close();
    for (const mem of this.memories.values()) {
      mem.close();
    }
    this.memories.clear();
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
    log.info(`AgentRuntime stopped: ${this.agentId}`);
  }
}
