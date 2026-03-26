import type { LLMResponse, Message, ToolDefinition } from "../types.ts";
import { BaseProvider } from "./base.ts";
import { ProviderError } from "../utils/errors.ts";
import { log } from "../utils/log.ts";

/**
 * CLI Provider — shells out to local CLI tools (claude, codex).
 *
 * The CLI handles its own auth (tokens in ~/.claude, ~/.codex, etc.).
 * Works locally, or via tunnel in the distributed architecture.
 */
export class CLIProvider extends BaseProvider {
  private binary: string;

  constructor(binary: string) {
    super("", "");
    this.binary = binary;
  }

  protected getDefaultApiBase(): string {
    return "";
  }

  async complete(
    messages: Message[],
    _model: string,
    _temperature?: number,
    _maxTokens?: number,
    _tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    // Build the prompt from messages
    const prompt = messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n\n");

    const systemPrompt = messages.find((m) => m.role === "system")?.content;

    try {
      const args = this.buildArgs(prompt, systemPrompt);
      log.info(`CLI provider: ${this.binary} ${args.slice(0, 3).join(" ")}...`);

      const cmd = new Deno.Command(this.binary, {
        args,
        stdout: "piped",
        stderr: "piped",
      });

      const { stdout, stderr, success } = await cmd.output();
      const out = new TextDecoder().decode(stdout).trim();
      const err = new TextDecoder().decode(stderr).trim();

      if (!success) {
        throw new ProviderError(
          "CLI_EXEC_FAILED",
          { binary: this.binary, stderr: err },
          `Check that ${this.binary} is installed and authenticated`,
        );
      }

      if (err) log.debug(`CLI stderr: ${err}`);

      return {
        content: out,
        finishReason: "stop",
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;

      const msg = (e as Error).message;
      if (msg.includes("not found") || msg.includes("No such file")) {
        throw new ProviderError(
          "CLI_NOT_FOUND",
          { binary: this.binary },
          `Install ${this.binary}: see https://${this.binary === "claude" ? "claude.ai/cli" : "openai.com/codex"}`,
        );
      }

      throw new ProviderError(
        "CLI_ERROR",
        { binary: this.binary, message: msg },
        "Check CLI installation and auth",
      );
    }
  }

  private buildArgs(prompt: string, systemPrompt?: string): string[] {
    switch (this.binary) {
      case "claude":
        // claude --print --model claude-sonnet-4-6 "prompt"
        return [
          "--print",
          ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
          prompt,
        ];

      case "codex":
        // codex --quiet "prompt"
        return [
          "--quiet",
          "--prompt", prompt,
        ];

      default:
        // Generic: assume it accepts prompt as last arg
        return [prompt];
    }
  }
}
