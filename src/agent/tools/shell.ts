import type {
  ApprovalReason,
  ExecPolicy,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";

/** Shell operators that indicate command chaining — blocked in allowlist mode. */
const SHELL_OPERATORS = /[;|&`]|&&|\|\||>>|<<|\$\(/;

/** Interpreters whose inline eval flags (-c, -e) are blocked when allowInlineEval is off. */
const EVAL_INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "deno",
  "bun",
]);
const EVAL_FLAGS = new Set(["-c", "-e", "eval"]);

/** Default env prefixes always stripped from subprocess env. */
const DEFAULT_DENIED_ENV_PREFIXES = ["LD_", "DYLD_"];

export interface ExecPolicyCheck {
  allowed: boolean;
  reason?: ApprovalReason | "denied";
  binary?: string;
}

/** Check a command string against an ExecPolicy. */
export function checkExecPolicy(
  command: string,
  policy: ExecPolicy,
): ExecPolicyCheck {
  if (policy.security === "deny") {
    return { allowed: false, reason: "denied" };
  }

  if (policy.security === "full") {
    return { allowed: true };
  }

  // security === "allowlist"
  const binary = command.trim().split(/\s+/)[0];

  // Denied commands — keyword blocklist, intentionally matches anywhere in command string
  if (policy.deniedCommands?.some((d) => command.includes(d))) {
    return { allowed: false, reason: "denied", binary };
  }

  // Shell operators — reject in allowlist mode
  if (SHELL_OPERATORS.test(command)) {
    return { allowed: false, reason: "shell-operator", binary };
  }

  // Inline eval — block -c/-e on known interpreters unless explicitly allowed
  if (!policy.allowInlineEval) {
    if (EVAL_INTERPRETERS.has(binary)) {
      const parts = command.trim().split(/\s+/);
      if (parts.some((p) => EVAL_FLAGS.has(p))) {
        return { allowed: false, reason: "inline-eval", binary };
      }
    }
  }

  // Allowlist check — empty list = deny all (AX #2 Safe Defaults)
  const allowed = policy.allowedCommands ?? [];
  if (!allowed.includes(binary)) {
    return { allowed: false, reason: "not-in-allowlist", binary };
  }

  // ask: "always" — force approval flow even for allowlisted commands
  if (policy.ask === "always") {
    return { allowed: false, reason: "always-ask", binary };
  }

  return { allowed: true, binary };
}

/** Filter dangerous env vars from a copy of the current environment. */
export function filterEnv(extra?: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const prefixes = [...DEFAULT_DENIED_ENV_PREFIXES, ...(extra ?? [])];
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (!prefixes.some((p) => k.startsWith(p))) {
      env[k] = v;
    }
  }
  env["DENOCLAW_EXEC"] = "1";
  return env;
}

/** Parse a command string into binary + args for direct execution (no sh -c). */
export function parseCommand(
  command: string,
): { binary: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  return { binary: parts[0], args: parts.slice(1) };
}

export class ShellTool extends BaseTool {
  name = "shell";
  description = "Execute shell commands (dry_run by default)";
  permissions = ["run" as const];

  private restrictToWorkspace: boolean;

  constructor(restrictToWorkspace = false) {
    super();
    this.restrictToWorkspace = restrictToWorkspace;
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
            command: {
              type: "string",
              description: "The shell command to execute",
            },
            dry_run: {
              type: "boolean",
              description:
                "Preview the command without executing (default: true)",
            },
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
      return this.fail(
        "MISSING_ARG",
        { arg: "command" },
        "Provide a command string",
      );
    }

    // AX: dry_run by default — preview without executing
    if (dryRun) {
      return this.ok(
        `[dry_run] Would execute: ${command}\nSet dry_run=false to execute.`,
      );
    }

    // Direct binary execution — no sh -c (ADR-010)
    const { binary, args: cmdArgs } = parseCommand(command);

    try {
      const cmd = new Deno.Command(binary, {
        args: cmdArgs,
        stdout: "piped",
        stderr: "piped",
        env: filterEnv(),
        cwd: this.restrictToWorkspace ? Deno.cwd() : undefined,
      });

      const { stdout, stderr, success } = await cmd.output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);

      if (!success) {
        return this.fail(
          "COMMAND_FAILED",
          { command, binary, stderr: err, stdout: out },
          "Check command syntax and permissions",
        );
      }

      const output = out + (err ? `\nSTDERR:\n${err}` : "");
      return this.ok(output || "(no output)");
    } catch (e) {
      return this.fail(
        "COMMAND_EXEC_ERROR",
        { command, binary, message: (e as Error).message },
        "Check that the command exists and is accessible",
      );
    }
  }
}
