import type {
  CommandMode,
  ExecPolicy,
  ShellConfig,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";

/** Shell operators that require a real shell interpreter. */
const SHELL_OPERATORS = /&&|\|\||\||;|`|\$\(/;
const SHELL_REDIRECTION_TOKEN = /^(?:\d+)?(?:>>?|<<)$/;
const SHELL_REDIRECTION_PREFIX = /^(?:\d+)?(?:>>?|<<).+/;
const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "mksh",
  "fish",
]);
const SHELL_INTERPRETER_WRAPPERS = new Set(["env", "busybox"]);
const SHELL_INLINE_EXEC_FLAGS = new Set(["-c", "-ic", "-lc"]);

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
export const DEFAULT_PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
  "COLORTERM",
  "LOG_LEVEL",
  "DENOCLAW_EXEC",
] as const;

export interface ExecPolicyCheck {
  allowed: boolean;
  reason?:
    | "not-in-allowlist"
    | "inline-eval"
    | "denied"
    | "invalid-policy"
    | "unsupported-shell-syntax";
  binary?: string;
  recovery?: string;
}

/** Check a command string against an ExecPolicy. */
export function checkExecPolicy(
  command: string,
  policy: ExecPolicy,
  shell?: ShellConfig,
): ExecPolicyCheck {
  const { binary } = parseCommand(command);
  const mode = resolveCommandMode(shell);

  if (shell?.enabled === false) {
    return {
      allowed: false,
      reason: "denied",
      binary,
      recovery: "Set sandbox.shell.enabled to true to allow shell execution",
    };
  }

  if (policy.security === "deny") {
    return {
      allowed: false,
      reason: "denied",
      binary,
      recovery: "Change execPolicy.security to 'allowlist' or 'full'",
    };
  }

  if (mode === "system-shell") {
    if (policy.security !== "full") {
      return {
        allowed: false,
        reason: "invalid-policy",
        binary: "sh",
        recovery:
          "Set sandbox.shell.mode to 'system-shell' only with execPolicy.security='full'",
      };
    }

    return { allowed: true, binary: "sh" };
  }

  if (requiresSystemShell(command)) {
    return {
      allowed: false,
      reason: "unsupported-shell-syntax",
      binary,
      recovery:
        "Set sandbox.shell.mode to 'system-shell' to enable shell interpreters, pipes, redirects, and command chaining",
    };
  }

  if (policy.security === "full") {
    return { allowed: true, binary };
  }

  // security === "allowlist"
  // Denied commands — keyword blocklist, intentionally matches anywhere in command string
  if (policy.deniedCommands?.some((d) => command.includes(d))) {
    return { allowed: false, reason: "denied", binary };
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

  return { allowed: true, binary };
}

/** Filter dangerous env vars from a copy of the current environment. */
export function filterEnv(extra?: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const prefixes = [...DEFAULT_DENIED_ENV_PREFIXES, ...(extra ?? [])];
  for (const [k, v] of Object.entries(readAvailableEnv())) {
    if (!prefixes.some((p) => k.startsWith(p))) {
      env[k] = v;
    }
  }
  env["DENOCLAW_EXEC"] = "1";
  return env;
}

function readAvailableEnv(): Record<string, string> {
  try {
    return Deno.env.toObject();
  } catch {
    const env: Record<string, string> = {};
    for (const key of DEFAULT_PASSTHROUGH_ENV_KEYS) {
      try {
        const value = Deno.env.get(key);
        if (value !== undefined) {
          env[key] = value;
        }
      } catch {
        // Ignore variables that are not readable under current Deno permissions.
      }
    }
    return env;
  }
}

/** Parse a command string into binary + args for direct execution (no sh -c). */
export function parseCommand(
  command: string,
): { binary: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  return { binary: parts[0], args: parts.slice(1) };
}

export function requiresSystemShell(command: string): boolean {
  const { binary, args } = parseCommand(command);
  return hasSystemShellSyntax(command) ||
    hasInlineShellInterpreterExecution(binary, args);
}

export class ShellTool extends BaseTool {
  name = "shell";
  description =
    "Execute commands (direct mode by default; system-shell opt-in)";
  permissions = ["run" as const];

  private restrictToWorkspace: boolean;
  private shell: ShellConfig;

  constructor(restrictToWorkspace = false, shell: ShellConfig = {}) {
    super();
    this.restrictToWorkspace = restrictToWorkspace;
    this.shell = shell;
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

    if (this.shell.enabled === false) {
      return this.fail(
        "SHELL_DISABLED",
        { command },
        "Set sandbox.shell.enabled to true to allow shell execution",
      );
    }

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
        `[dry_run] Would execute (${
          resolveCommandMode(this.shell)
        }): ${command}\nSet dry_run=false to execute.`,
      );
    }

    if (resolveCommandMode(this.shell) === "system-shell") {
      return await this.executeWithSystemShell(command);
    }

    return await this.executeDirect(command);
  }

  private async executeDirect(command: string): Promise<ToolResult> {
    const { binary, args: cmdArgs } = parseCommand(command);

    if (requiresSystemShell(command)) {
      return this.fail(
        "UNSUPPORTED_SHELL_SYNTAX",
        { command, binary, mode: "direct" },
        "Set sandbox.shell.mode to 'system-shell' to enable pipes, redirects, shell interpreters, and command chaining",
      );
    }

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

  private async executeWithSystemShell(command: string): Promise<ToolResult> {
    try {
      const cmd = new Deno.Command("sh", {
        args: ["-c", command],
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
          {
            command,
            binary: "sh",
            stderr: err,
            stdout: out,
            mode: "system-shell",
          },
          "Check command syntax and permissions",
        );
      }

      const output = out + (err ? `\nSTDERR:\n${err}` : "");
      return this.ok(output || "(no output)");
    } catch (e) {
      return this.fail(
        "COMMAND_EXEC_ERROR",
        {
          command,
          binary: "sh",
          message: (e as Error).message,
          mode: "system-shell",
        },
        "Check that the shell interpreter exists and is accessible",
      );
    }
  }
}

function resolveCommandMode(shell?: ShellConfig): CommandMode {
  return shell?.mode ?? "direct";
}

function hasSystemShellSyntax(command: string): boolean {
  if (SHELL_OPERATORS.test(command)) {
    return true;
  }

  const parts = command.trim().split(/\s+/);
  return parts.some((part) =>
    SHELL_REDIRECTION_TOKEN.test(part) ||
    SHELL_REDIRECTION_PREFIX.test(part)
  );
}

function hasInlineShellInterpreterExecution(
  binary: string,
  args: string[],
): boolean {
  const normalizedBinary = getCommandBasename(binary);

  if (SHELL_INTERPRETERS.has(normalizedBinary)) {
    return args.some((arg) => SHELL_INLINE_EXEC_FLAGS.has(arg));
  }

  if (!SHELL_INTERPRETER_WRAPPERS.has(normalizedBinary) || args.length === 0) {
    return false;
  }

  const wrapped = resolveWrappedBinary(args);
  if (!wrapped) return false;

  return wrapped.args.some((arg) => SHELL_INLINE_EXEC_FLAGS.has(arg));
}

function resolveWrappedBinary(
  args: string[],
): { binary: string; args: string[] } | null {
  let index = 0;

  while (index < args.length) {
    const part = args[index];
    if (!part) break;

    if (part === "-i" || part === "--ignore-environment") {
      index++;
      continue;
    }

    if (part === "-u") {
      index += 2;
      continue;
    }

    if (part.includes("=")) {
      index++;
      continue;
    }

    const binary = getCommandBasename(part);
    if (!SHELL_INTERPRETERS.has(binary)) {
      return null;
    }

    return {
      binary,
      args: args.slice(index + 1),
    };
  }

  return null;
}

function getCommandBasename(binary: string): string {
  const parts = binary.split(/[\\/]/);
  return parts.at(-1) ?? binary;
}
