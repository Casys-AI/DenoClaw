import type { AgentBrokerPort, BrokerEnvelope } from "../shared/types.ts";
import type { AgentConfig } from "./types.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { Task } from "../messaging/a2a/types.ts";
import {
  createCanonicalTask,
  transitionTask,
} from "../messaging/a2a/internal_contract.ts";
import {
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
type BrokerTaskReporter = AgentBrokerPort & {
  reportTaskResult(task: Task): Promise<Task>;
};

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
          await this.handleUserMessage(msg);
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

  private async handleUserMessage(msg: BrokerEnvelope): Promise<void> {
    const payload = msg.payload as {
      instruction: string;
      data?: unknown;
      taskId?: string;
      contextId?: string;
    };
    log.info(
      `Message reçu de ${msg.from}: ${payload.instruction.slice(0, 100)}`,
    );

    const sessionId = `agent:${msg.from}:${this.agentId}`;
    const memory = await this.getMemory(sessionId);
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

    if (canonicalTask) {
      await this.reportCanonicalTaskResult(
        transitionTask(canonicalTask, "WORKING"),
      );
    }

    await memory.addMessage({ role: "user", content: payload.instruction });

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

            const result = await this.broker.execTool(tc.function.name, args);

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
            transitionTask(canonicalTask, "WORKING"),
            response.content,
          );
          await this.reportCanonicalTaskResult(completedTask);
          log.info(
            `Tâche canonique terminée pour ${msg.from} (${iteration} itérations)`,
          );
          return;
        }

        await this.broker.sendToAgent(msg.from, response.content);
        log.info(`Réponse envoyée à ${msg.from} (${iteration} itérations)`);
        return;
      }

      if (canonicalTask) {
        await this.reportCanonicalTaskResult(
          mapTaskErrorToTerminalStatus(
            transitionTask(canonicalTask, "WORKING"),
            new Error("Max iterations reached."),
          ),
        );
        return;
      }

      await this.broker.sendToAgent(msg.from, "Max iterations reached.");
    } catch (error) {
      if (canonicalTask) {
        await this.reportCanonicalTaskResult(
          mapTaskErrorToTerminalStatus(
            transitionTask(canonicalTask, "WORKING"),
            error,
          ),
        );
      }
      throw error;
    }
  }

  private async reportCanonicalTaskResult(task: Task): Promise<void> {
    const broker = this.broker as Partial<BrokerTaskReporter>;
    if (typeof broker.reportTaskResult !== "function") {
      throw new Error(
        "AgentBrokerPort does not expose reportTaskResult(); broker-backed canonical task updates are unavailable",
      );
    }
    await broker.reportTaskResult(task);
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
