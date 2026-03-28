import type {
  AgentBrokerPort,
  ApprovalReason,
  BrokerEnvelope,
  ToolResult,
} from "../shared/types.ts";
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
} from "../messaging/a2a/internal_mapping.ts";
import { KvdexMemory } from "./memory_kvdex.ts";
import { ContextBuilder } from "./context.ts";
import { SkillsLoader } from "./skills.ts";
import { CronManager } from "./cron.ts";
import { log } from "../shared/log.ts";

/**
 * AgentRuntime — runs inside a Deno Subhosting deployment.
 *
 * This is the orchestrator:
 * - Starts the broker-facing runtime port (transport decided by AgentBrokerPort)
 * - Calls LLM via AgentBrokerPort (never directly)
 * - Dispatches tool execution to Sandbox (via AgentBrokerPort)
 * - Persists state via MemoryPort (KvdexMemory by default)
 * - Runs heartbeat via Deno.cron
 *
 * No code executes here — all execution goes through Sandbox.
 * Depends on AgentBrokerPort interface (DI), not on BrokerClient concret.
 */
type BrokerCanonicalTaskPort = AgentBrokerPort & {
  getTask(taskId: string): Promise<Task | null>;
  reportTaskResult(task: Task): Promise<Task>;
};

interface LegacyAgentMessagePayload {
  instruction: string;
  data?: unknown;
  taskId?: string;
  contextId?: string;
}

interface RuntimeTaskSubmitPayload {
  taskId: string;
  message: A2AMessage;
  contextId?: string;
}

interface RuntimeTaskContinuePayload {
  taskId: string;
  message: A2AMessage;
  metadata?: Record<string, unknown>;
}

export class AgentRuntime {
  private agentId: string;
  private config: AgentConfig;
  private broker: AgentBrokerPort;
  private kv: Deno.Kv | null = null;
  private context: ContextBuilder;
  private skills: SkillsLoader;
  private cron: CronManager;
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
    this.cron = new CronManager();
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
    log.info(`AgentRuntime démarré : ${this.agentId}`);

    await this.skills.loadSkills();
    await this.broker.startListening();

    const kv = await this.getKv();
    kv.listenQueue(async (raw: unknown) => {
      const msg = raw as BrokerEnvelope;
      if (msg.to !== this.agentId) return;

      switch (msg.type) {
        case "agent_message":
          await this.handleLegacyAgentMessage(msg);
          break;
        case "task_submit":
          await this.handleTaskSubmitMessage(msg);
          break;
        case "task_continue":
          await this.handleTaskContinueMessage(msg);
          break;
        default:
          log.debug(`Message type ignoré dans runtime : ${msg.type}`);
      }
    });

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

  private async handleLegacyAgentMessage(msg: BrokerEnvelope): Promise<void> {
    const payload = msg.payload as LegacyAgentMessagePayload;
    log.info(
      `Message reçu de ${msg.from}: ${payload.instruction.slice(0, 100)}`,
    );

    const canonicalTask = payload.taskId
      ? createCanonicalTask({
        id: payload.taskId,
        contextId: payload.contextId,
        message: {
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: payload.instruction }],
        },
      })
      : null;

    await this.executeConversation({
      fromAgentId: msg.from,
      inputText: payload.instruction,
      canonicalTask,
      reportWorkingTransition: canonicalTask !== null,
      legacyReplyTarget: canonicalTask ? undefined : msg.from,
    });
  }

  private async handleTaskSubmitMessage(msg: BrokerEnvelope): Promise<void> {
    const payload = msg.payload as RuntimeTaskSubmitPayload;
    const inputText = this.extractTextFromMessage(payload.message);
    log.info(`Tâche canonique reçue de ${msg.from}: ${inputText.slice(0, 100)}`);

    await this.executeConversation({
      fromAgentId: msg.from,
      inputText,
      canonicalTask: createCanonicalTask({
        id: payload.taskId,
        contextId: payload.contextId,
        message: payload.message,
      }),
      reportWorkingTransition: true,
    });
  }

  private async handleTaskContinueMessage(msg: BrokerEnvelope): Promise<void> {
    const payload = msg.payload as RuntimeTaskContinuePayload;
    const existing = await this.getCanonicalTaskPort().getTask(payload.taskId);
    if (!existing) {
      throw new Error(
        `Broker-backed continuation received unknown task ${payload.taskId}`,
      );
    }

    const resumed = transitionTask(existing, "WORKING", {
      message: payload.message,
    });
    resumed.history = [...existing.history, payload.message];
    await this.reportCanonicalTaskResult(resumed);

    const inputText = this.extractTextFromMessage(payload.message);
    log.info(`Continuation canonique reçue de ${msg.from}: ${inputText.slice(0, 100)}`);

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
    canonicalTask?: Task | null;
    reportWorkingTransition: boolean;
    legacyReplyTarget?: string;
  }): Promise<void> {
    const sessionId = `agent:${options.fromAgentId}:${this.agentId}`;
    const memory = await this.getMemory(sessionId);
    let canonicalTask = options.canonicalTask ?? null;

    if (canonicalTask && options.reportWorkingTransition) {
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
              canonicalTask
                ? { taskId: canonicalTask.id, contextId: canonicalTask.contextId }
                : undefined,
            );

            if (canonicalTask) {
              const approvalPause = this.extractApprovalPause(result);
              if (approvalPause) {
                await memory.addMessage({
                  role: "tool",
                  content: `Approval required [${approvalPause.reason}]: ${approvalPause.command}`,
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
                  `Tâche canonique en pause INPUT_REQUIRED pour ${options.fromAgentId}`,
                );
                return;
              }
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

        if (canonicalTask) {
          const completedTask = mapTaskResultToCompletion(
            canonicalTask,
            response.content,
          );
          await this.reportCanonicalTaskResult(completedTask);
          log.info(
            `Tâche canonique terminée pour ${options.fromAgentId} (${iteration} itérations)`,
          );
          return;
        }

        await this.broker.sendToAgent(
          options.legacyReplyTarget ?? options.fromAgentId,
          response.content,
        );
        log.info(
          `Réponse envoyée à ${options.legacyReplyTarget ?? options.fromAgentId} (${iteration} itérations)`,
        );
        return;
      }

      if (canonicalTask) {
        await this.reportCanonicalTaskResult(
          mapTaskErrorToTerminalStatus(
            canonicalTask,
            new Error("Max iterations reached."),
          ),
        );
        return;
      }

      await this.broker.sendToAgent(
        options.legacyReplyTarget ?? options.fromAgentId,
        "Max iterations reached.",
      );
    } catch (error) {
      if (canonicalTask) {
        await this.reportCanonicalTaskResult(
          mapTaskErrorToTerminalStatus(canonicalTask, error),
        );
      }
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
      throw new Error(
        "AgentBrokerPort does not expose getTask(); broker-backed canonical continuation is unavailable",
      );
    }
    if (typeof broker.reportTaskResult !== "function") {
      throw new Error(
        "AgentBrokerPort does not expose reportTaskResult(); broker-backed canonical task updates are unavailable",
      );
    }
    return broker as BrokerCanonicalTaskPort;
  }

  private extractApprovalPause(
    result: ToolResult,
  ): { command: string; binary: string; reason: ApprovalReason; prompt: string } | null {
    if (result.success || result.error?.code !== "EXEC_APPROVAL_REQUIRED") {
      return null;
    }

    const context = result.error.context;
    if (!context || typeof context !== "object") return null;

    const command = typeof context.command === "string" ? context.command : null;
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
    log.info(`AgentRuntime arrêté : ${this.agentId}`);
  }
}
