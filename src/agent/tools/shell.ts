import type { ToolDefinition, ToolResult } from "../../types.ts";
import { BaseTool } from "./registry.ts";

export class ShellTool extends BaseTool {
  name = "shell";
  description = "Execute shell commands (dry_run by default)";
  permissions = ["run" as const];

  private allowedCommands?: string[];
  private deniedCommands?: string[];
  private restrictToWorkspace: boolean;

  constructor(restrictToWorkspace = false, allowedCommands?: string[], deniedCommands?: string[]) {
    super();
    this.restrictToWorkspace = restrictToWorkspace;
    this.allowedCommands = allowedCommands;
    this.deniedCommands = deniedCommands;
  }

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to execute" },
            dry_run: { type: "boolean", description: "Preview the command without executing (default: true)" },
          },
          required: ["command"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const dryRun = args.dry_run !== false; // AX: safe default = true

    if (!command) {
      return this.fail("MISSING_ARG", { arg: "command" }, "Provide a command string");
    }

    if (this.deniedCommands?.some((d) => command.includes(d))) {
      return this.fail(
        "COMMAND_DENIED",
        { command, deniedKeywords: this.deniedCommands },
        "Remove denied keywords or update config.tools.deniedCommands",
      );
    }

    if (this.allowedCommands?.length && !this.allowedCommands.some((a) => command.startsWith(a))) {
      return this.fail(
        "COMMAND_NOT_ALLOWED",
        { command, allowedCommands: this.allowedCommands },
        `Use one of: ${this.allowedCommands.join(", ")}`,
      );
    }

    // AX: dry_run by default — preview without executing
    if (dryRun) {
      return this.ok(`[dry_run] Would execute: ${command}\nSet dry_run=false to execute.`);
    }

    try {
      const cmd = new Deno.Command("sh", {
        args: ["-c", command],
        stdout: "piped",
        stderr: "piped",
        cwd: this.restrictToWorkspace ? Deno.cwd() : undefined,
      });

      const { stdout, stderr, success } = await cmd.output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);

      if (!success) {
        return this.fail(
          "COMMAND_FAILED",
          { command, stderr: err, stdout: out },
          "Check command syntax and permissions",
        );
      }

      const output = out + (err ? `\nSTDERR:\n${err}` : "");
      return this.ok(output || "(no output)");
    } catch (e) {
      return this.fail(
        "COMMAND_EXEC_ERROR",
        { command, message: (e as Error).message },
        "Check that the command exists and is accessible",
      );
    }
  }
}
