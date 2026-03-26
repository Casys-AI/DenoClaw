import type { AgentConfig, AgentResponse, Config } from "../types.ts";
import { ProviderManager } from "../providers/manager.ts";
import { Memory } from "./memory.ts";
import { ContextBuilder } from "./context.ts";
import { SkillsLoader } from "./skills.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ShellTool } from "./tools/shell.ts";
import { ReadFileTool, WriteFileTool } from "./tools/file.ts";
import { WebFetchTool } from "./tools/web.ts";
import { log } from "../utils/log.ts";
import { spanAgentLoop, spanToolCall } from "../telemetry/mod.ts";

export class AgentLoop {
  private config: AgentConfig;
  private providers: ProviderManager;
  private memory: Memory;
  private context: ContextBuilder;
  private skills: SkillsLoader;
  private tools: ToolRegistry;
  private maxIterations: number;

  constructor(sessionId: string, config: Config, agentConfig?: Partial<AgentConfig>, maxIterations = 10) {
    this.config = {
      model: config.agents?.defaults?.model || "anthropic/claude-sonnet-4-6",
      temperature: config.agents?.defaults?.temperature ?? 0.7,
      maxTokens: config.agents?.defaults?.maxTokens ?? 4096,
      systemPrompt: config.agents?.defaults?.systemPrompt,
      ...agentConfig,
    };

    this.providers = new ProviderManager(config);
    this.memory = new Memory(sessionId);
    this.context = new ContextBuilder(this.config);
    this.skills = new SkillsLoader();
    this.tools = new ToolRegistry();
    this.maxIterations = maxIterations;

    this.registerBuiltInTools(config);
  }

  private registerBuiltInTools(config: Config): void {
    const t = config.tools;
    this.tools.register(new ShellTool(t?.restrictToWorkspace, t?.allowedCommands, t?.deniedCommands));
    this.tools.register(new ReadFileTool());
    this.tools.register(new WriteFileTool());
    this.tools.register(new WebFetchTool());
  }

  async initialize(): Promise<void> {
    await this.memory.load();
    await this.skills.loadSkills();
  }

  async processMessage(userMessage: string): Promise<AgentResponse> {
    await this.initialize();

    await this.memory.addMessage({ role: "user", content: userMessage });

    let iteration = 0;

    while (iteration < this.maxIterations) {
      iteration++;

      // Each iteration is wrapped in an OTEL span
      const iterResult = await spanAgentLoop(this.memory["sessionId"], iteration, async () => {
        log.debug(`Boucle agent itération ${iteration}/${this.maxIterations}`);

        const skillsList = this.skills.getSkills();
        const toolDefs = this.tools.getDefinitions();
        const raw = this.context.buildContextMessages(this.memory.getMessages(), skillsList, toolDefs);

        const CHARS_PER_TOKEN = 4;
        const CONTEXT_RATIO = 4;
        const maxChars = (this.config.maxTokens || 4096) * CHARS_PER_TOKEN * CONTEXT_RATIO;
        const contextMessages = this.context.truncateContext(raw, maxChars);

        const response = await this.providers.complete(
          contextMessages,
          this.config.model,
          this.config.temperature,
          this.config.maxTokens,
          toolDefs,
        );

        log.debug(`LLM: content=${!!response.content} tools=${response.toolCalls?.length ?? 0}`);

        if (response.toolCalls?.length) {
          await this.memory.addMessage({
            role: "assistant",
            content: response.content || "",
            tool_calls: response.toolCalls,
          });

          for (const tc of response.toolCalls) {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              log.warn(`JSON invalide pour outil ${tc.function.name}`);
              await this.memory.addMessage({
                role: "tool",
                content: `Error: Invalid JSON arguments for ${tc.function.name}`,
                name: tc.function.name,
                tool_call_id: tc.id,
              });
              continue;
            }

            log.info(`Outil: ${tc.function.name}`);
            const result = await spanToolCall(tc.function.name, () =>
              this.tools.execute(tc.function.name, args)
            );

            await this.memory.addMessage({
              role: "tool",
              content: result.success
                ? result.output
                : `Error [${result.error?.code}]: ${JSON.stringify(result.error?.context)}\nRecovery: ${result.error?.recovery ?? "none"}`,
              name: tc.function.name,
              tool_call_id: tc.id,
            });
          }

          return null; // continue loop
        }

        // Final text response
        await this.memory.addMessage({ role: "assistant", content: response.content });
        return { content: response.content, finishReason: response.finishReason } as AgentResponse;
      });

      if (iterResult !== null) return iterResult;
    }

    log.warn(`Max itérations atteint (${this.maxIterations})`);
    const last = this.memory.getMessages().findLast((m) => m.role === "assistant");
    return {
      content: last?.content || "Max iterations reached without a final response.",
      finishReason: "max_iterations",
    };
  }

  getMemory(): Memory {
    return this.memory;
  }

  getTools(): ToolRegistry {
    return this.tools;
  }
}
