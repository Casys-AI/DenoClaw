import type { AgentConfig, Message } from "../shared/types.ts";
import type { BrokerMessage } from "../orchestration/types.ts";
import { BrokerClient } from "../orchestration/client.ts";
import { ContextBuilder } from "./context.ts";
import { SkillsLoader } from "./skills.ts";
import { CronManager } from "./cron.ts";
import { log } from "../shared/log.ts";

/**
 * AgentRuntime — runs inside a Deno Subhosting deployment.
 *
 * This is the orchestrator:
 * - Listens for messages via KV Queues
 * - Calls LLM via BrokerClient (never directly)
 * - Dispatches tool execution to Sandbox (via BrokerClient)
 * - Persists state in its own KV
 * - Runs heartbeat via Deno.cron
 *
 * No code executes here — all execution goes through Sandbox.
 */
export class AgentRuntime {
  private agentId: string;
  private config: AgentConfig;
  private broker: BrokerClient;
  private kv: Deno.Kv | null = null;
  private context: ContextBuilder;
  private skills: SkillsLoader;
  private cron: CronManager;
  private maxIterations: number;

  constructor(agentId: string, config: AgentConfig, maxIterations = 10) {
    this.agentId = agentId;
    this.config = config;
    this.broker = new BrokerClient(agentId);
    this.context = new ContextBuilder(config);
    this.skills = new SkillsLoader();
    this.cron = new CronManager();
    this.maxIterations = maxIterations;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  /**
   * Start the agent runtime. Listens for messages and runs heartbeat.
   */
  async start(): Promise<void> {
    log.info(`AgentRuntime démarré : ${this.agentId}`);

    await this.skills.loadSkills();
    await this.broker.startListening();

    // Listen for incoming messages via KV Queue
    const kv = await this.getKv();
    kv.listenQueue(async (raw: unknown) => {
      const msg = raw as BrokerMessage;
      if (msg.to !== this.agentId) return;

      switch (msg.type) {
        case "agent_message":
          await this.handleUserMessage(msg);
          break;
        default:
          log.debug(`Message type ignoré dans runtime : ${msg.type}`);
      }
    });

    // Heartbeat — check for pending tasks, health check
    await this.cron.heartbeat(async () => {
      log.debug(`Heartbeat: ${this.agentId}`);
      const kv = await this.getKv();
      await kv.set(["agents", this.agentId, "status"], {
        status: "alive",
        lastHeartbeat: new Date().toISOString(),
      });
    }, 5);

    // Register agent status
    await kv.set(["agents", this.agentId, "status"], {
      status: "running",
      startedAt: new Date().toISOString(),
      model: this.config.model,
    });
  }

  /**
   * Handle an incoming user/agent message.
   * Runs the ReAct loop: LLM → tool calls → LLM → ... → final response.
   */
  private async handleUserMessage(msg: BrokerMessage): Promise<void> {
    const payload = msg.payload as { instruction: string; data?: unknown };
    log.info(`Message reçu de ${msg.from}: ${payload.instruction.slice(0, 100)}`);

    const kv = await this.getKv();

    // Load conversation history from KV
    const historyEntry = await kv.get<Message[]>(["memory", this.agentId, msg.from]);
    const history: Message[] = historyEntry.value || [];

    // Add user message
    history.push({ role: "user", content: payload.instruction });

    let iteration = 0;
    while (iteration < this.maxIterations) {
      iteration++;

      // Build context
      const skillsList = this.skills.getSkills();
      const contextMessages = this.context.buildContextMessages(history, skillsList, []);

      // Call LLM via broker (broker handles API keys / CLI tunnel routing)
      const response = await this.broker.complete(
        contextMessages,
        this.config.model,
        this.config.temperature,
        this.config.maxTokens,
      );

      if (response.toolCalls?.length) {
        history.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });

        // Execute tools via broker → routed to Sandbox or tunnel
        for (const tc of response.toolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            history.push({
              role: "tool",
              content: `Error [INVALID_JSON]: bad arguments for ${tc.function.name}`,
              name: tc.function.name,
              tool_call_id: tc.id,
            });
            continue;
          }

          const result = await this.broker.execTool(tc.function.name, args);

          history.push({
            role: "tool",
            content: result.success
              ? result.output
              : `Error [${result.error?.code}]: ${JSON.stringify(result.error?.context)}\nRecovery: ${result.error?.recovery ?? "none"}`,
            name: tc.function.name,
            tool_call_id: tc.id,
          });
        }

        continue;
      }

      // Final response
      history.push({ role: "assistant", content: response.content });

      // Persist history
      await kv.set(["memory", this.agentId, msg.from], history);

      // Send response back to sender via broker
      await this.broker.sendToAgent(msg.from, response.content);

      log.info(`Réponse envoyée à ${msg.from} (${iteration} itérations)`);
      return;
    }

    // Max iterations
    await this.broker.sendToAgent(msg.from, "Max iterations reached.");
    await kv.set(["memory", this.agentId, msg.from], history);
  }

  async stop(): Promise<void> {
    this.cron.close();
    this.broker.close();
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
