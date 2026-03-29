import type {
  AgentBrokerPort,
  ApprovalReason,
  BrokerEnvelope,
  ToolResult,
} from "../shared/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import type { AgentConfig } from "./types.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { A2AMessage, Task } from "../messaging/a2a/types.ts";
import {
  createCanonicalTask,
  transitionTask,
} from "../messaging/a2a/internal_contract.ts";
import {
  mapApprovalPauseToInputRequiredTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../messaging/a2a/task_mapping.ts";
import { KvdexMemory } from "./memory_kvdex.ts";
import { ContextBuilder } from "./context.ts";
import { SkillsLoader } from "./skills.ts";
import { CronManager } from "./cron.ts";
import { log } from "../shared/log.ts";
import {
  assertRuntimeTaskMessage,
  extractContinuationTaskMessage,
  extractSubmitTaskMessage,
  isRuntimeTaskMessage,
  type RuntimeTaskContinueMessage,
  type RuntimeTaskSubmitMessage,
} from "./runtime_transport.ts";

/**
 * AgentRuntime — runs inside a Deno Subhosting deployment or local worker.
 *
 * HTTP-reactive, task-oriented runtime:
 * - Receives work via handleIncomingMessage() (transport-agnostic)
 * - Calls LLM via AgentBrokerPort (never directly)
 * - Dispatches tool execution to Sandbox (via AgentBrokerPort)
 * - Persists state via MemoryPort (KvdexMemory by default)
 *
 * Transport is decided by the caller: HTTP handler in Subhosting,
 * KV Queue listener in local mode. The runtime does not assume any
 * specific transport mechanism.
 */
type BrokerCanonicalTaskPort = AgentBrokerPort & {
  getTask(taskId: string): Promise<Task | null>;
  reportTaskResult(task: Task): Promise<Task>;
};

export class AgentRuntime {
  private agentId: string;
  private config: AgentConfig;
  private broker: AgentBrokerPort;
  private kv: Deno.Kv | null = null;
  private context: ContextBuilder;
  private skills: SkillsLoader;
  private cron!: CronManager;
  private maxIterations: number;
  private memories: Map<string, MemoryPort> = new Map();

  constructor(
    agentId: string,
    config: AgentConfig,
    broker: AgentBrokerPort,
    maxIterations = 10,
  ) {
    this.agentId = agentId;
    this.config = config;
    this.broker = broker;
    this.context = new ContextBuilder(config);
    this.skills = new SkillsLoader();
    this.maxIterations = maxIterations;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  private async getMemory(sessionId: string): Promise<MemoryPort> {
    let mem = this.memories.get(sessionId);
    if (!mem) {
      mem = new KvdexMemory(this.agentId, sessionId);
      await mem.load();
      this.memories.set(sessionId, mem);
    }
    return mem;
  }

  async start(): Promise<void> {
    log.info(`AgentRuntime started: ${this.agentId}`);

    await this.skills.loadSkills();
    await this.broker.startListening();

    const kv = await this.getKv();
    this.cron = new CronManager(kv);

    await this.cron.heartbeat(async () => {
      log.debug(`Heartbeat: ${this.agentId}`);
      const kv = await this.getKv();
      await kv.set(["agents", this.agentId, "status"], {
        status: "alive",
        lastHeartbeat: new Date().toISOString(),
      });
    }, 5);

    await kv.set(["agents", this.agentId, "status"], {
      status: "running",
      startedAt: new Date().toISOString(),
      model: this.config.model,
    });
  }

  /**
   * Start receiving work via KV Queue (local mode convenience).
   * In Subhosting, call handleIncomingMessage() from the HTTP handler instead.
   */
  async startKvQueueIntake(): Promise<void> {
    const kv = await this.getKv();
    kv.listenQueue(async (raw: unknown) => {
      const msg = raw as BrokerEnvelope;
      if (msg.to !== this.agentId) return;
      if (!isRuntimeTaskMessage(msg)) return;
      await this.handleIncomingMessage(msg);
    });
    log.info(`AgentRuntime: KV Queue intake started (${this.agentId})`);
  }

  /**
   * Handle an incoming broker message (transport-agnostic).
   * Called by KV Queue listener locally, or HTTP handler in Subhosting.
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
          const port = this.broker as Partial<BrokerCanonicalTaskPort>;
          if (
            typeof port.getTask === "function" &&
            typeof port.reportTaskResult === "function"
          ) {
            const existing = await port.getTask(taskId);
            if (existing) {
              const failed = mapTaskErrorToTerminalStatus(existing, e);
              await port.reportTaskResult(failed);
            }
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
    const inputText = this.extractTextFromMessage(taskMessage);
    log.info(
      `Canonical task received from ${msg.from}: ${inputText.slice(0, 100)}`,
    );

    await this.executeConversation({
      fromAgentId: msg.from,
      inputText,
      canonicalTask: createCanonicalTask({
        id: payload.taskId,
        contextId: payload.contextId,
        initialMessage: taskMessage,
      }),
      reportWorkingTransition: true,
    });
  }

  private async handleTaskContinueMessage(
    msg: RuntimeTaskContinueMessage,
  ): Promise<void> {
    const payload = msg.payload;
    const existing = await this.getCanonicalTaskPort().getTask(payload.taskId);
    if (!existing) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: payload.taskId },
        "Broker-backed continuation received unknown task",
      );
    }

    const continuationMessage = extractContinuationTaskMessage(payload);
    const resumed = transitionTask(existing, "WORKING", {
      statusMessage: continuationMessage,
    });
    resumed.history = [...existing.history, continuationMessage];
    await this.reportCanonicalTaskResult(resumed);

    const inputText = this.extractTextFromMessage(continuationMessage);
    log.info(
      `Canonical continuation received from ${msg.from}: ${inputText.slice(0, 100)}`,
    );

    await this.executeConversation({
      fromAgentId: msg.from,
      inputText,
      canonicalTask: resumed,
      reportWorkingTransition: false,
    });
  }

  private async executeConversation(options: {
    fromAgentId: string;
    inputText: string;
    canonicalTask: Task;
    reportWorkingTransition: boolean;
  }): Promise<void> {
    const sessionId = `agent:${options.fromAgentId}:${this.agentId}`;
    const memory = await this.getMemory(sessionId);
    let canonicalTask = options.canonicalTask;

    if (options.reportWorkingTransition) {
      canonicalTask = transitionTask(canonicalTask, "WORKING");
      await this.reportCanonicalTaskResult(canonicalTask);
    }

    await memory.addMessage({ role: "user", content: options.inputText });

    try {
      let iteration = 0;
      while (iteration < this.maxIterations) {
        iteration++;

        const skillsList = this.skills.getSkills();
        const contextMessages = this.context.buildContextMessages(
          memory.getMessages(),
          skillsList,
          [],
        );

        const response = await this.broker.complete(
          contextMessages,
          this.config.model,
          this.config.temperature,
          this.config.maxTokens,
        );

        if (response.toolCalls?.length) {
          await memory.addMessage({
            role: "assistant",
            content: response.content || "",
            tool_calls: response.toolCalls,
          });

          for (const tc of response.toolCalls) {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              await memory.addMessage({
                role: "tool",
                content:
                  `Error [INVALID_JSON]: bad arguments for ${tc.function.name}`,
                name: tc.function.name,
                tool_call_id: tc.id,
              });
              continue;
            }

            const result = await this.broker.execTool(
              tc.function.name,
              args,
              { taskId: canonicalTask.id, contextId: canonicalTask.contextId },
            );

            const approvalPause = this.extractApprovalPause(result);
            if (approvalPause) {
              await memory.addMessage({
                role: "tool",
                content:
                  `Approval required [${approvalPause.reason}]: ${approvalPause.command}`,
                name: tc.function.name,
                tool_call_id: tc.id,
              });
              const pausedTask = mapApprovalPauseToInputRequiredTask(
                canonicalTask,
                {
                  command: approvalPause.command,
                  binary: approvalPause.binary,
                  prompt: approvalPause.prompt,
                },
              );
              await this.reportCanonicalTaskResult(pausedTask);
              log.info(
                `Canonical task paused in INPUT_REQUIRED for ${options.fromAgentId}`,
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
              name: tc.function.name,
              tool_call_id: tc.id,
            });
          }

          continue;
        }

        await memory.addMessage({
          role: "assistant",
          content: response.content,
        });

        const completedTask = mapTaskResultToCompletion(
          canonicalTask,
          response.content,
        );
        await this.reportCanonicalTaskResult(completedTask);
        log.info(
          `Canonical task completed for ${options.fromAgentId} (${iteration} iterations)`,
        );
        return;
      }

      await this.reportCanonicalTaskResult(
        mapTaskErrorToTerminalStatus(
          canonicalTask,
          new Error("Max iterations reached."),
        ),
      );
    } catch (error) {
      await this.reportCanonicalTaskResult(
        mapTaskErrorToTerminalStatus(canonicalTask, error),
      );
      throw error;
    }
  }

  private extractTextFromMessage(message: A2AMessage): string {
    const text = message.parts
      .filter((part): part is Extract<typeof part, { kind: "text" }> =>
        part.kind === "text"
      )
      .map((part) => part.text)
      .join("\n")
      .trim();

    return text || "[non-text task payload]";
  }

  private getCanonicalTaskPort(): BrokerCanonicalTaskPort {
    const broker = this.broker as Partial<BrokerCanonicalTaskPort>;
    if (typeof broker.getTask !== "function") {
      throw new DenoClawError(
        "BROKER_PORT_MISSING_METHOD",
        { method: "getTask" },
        "Use a BrokerClient that supports canonical task operations",
      );
    }
    if (typeof broker.reportTaskResult !== "function") {
      throw new DenoClawError(
        "BROKER_PORT_MISSING_METHOD",
        { method: "reportTaskResult" },
        "Use a BrokerClient that supports canonical task operations",
      );
    }
    return broker as BrokerCanonicalTaskPort;
  }

  private extractApprovalPause(
    result: ToolResult,
  ):
    | {
      command: string;
      binary: string;
      reason: ApprovalReason;
      prompt: string;
    }
    | null {
    if (result.success || result.error?.code !== "EXEC_APPROVAL_REQUIRED") {
      return null;
    }

    const context = result.error.context;
    if (!context || typeof context !== "object") return null;

    const command = typeof context.command === "string"
      ? context.command
      : null;
    const binary = typeof context.binary === "string" ? context.binary : null;
    const reason = typeof context.reason === "string"
      ? context.reason as ApprovalReason
      : null;
    if (!command || !binary || !reason) return null;

    return {
      command,
      binary,
      reason,
      prompt: `Awaiting approval for ${binary}: ${command}`,
    };
  }

  private async reportCanonicalTaskResult(task: Task): Promise<void> {
    await this.getCanonicalTaskPort().reportTaskResult(task);
  }

  async stop(): Promise<void> {
    this.cron.close();
    this.broker.close();
    for (const mem of this.memories.values()) {
      mem.close();
    }
    this.memories.clear();
    if (this.kv) {
      await this.kv.set(["agents", this.agentId, "status"], {
        status: "stopped",
        stoppedAt: new Date().toISOString(),
      });
      this.kv.close();
      this.kv = null;
    }
    log.info(`AgentRuntime stopped: ${this.agentId}`);
  }
}
