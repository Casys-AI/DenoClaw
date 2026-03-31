import type {
  ExecPolicy,
  SandboxConfig,
  SandboxExecRequest,
  SandboxPermission,
  ToolResult,
} from "../../../shared/types.ts";
import { log } from "../../../shared/log.ts";
import { filterEnv } from "../shell.ts";
import { permissionToFlag } from "./permission_flags.ts";

const EXECUTOR_URL = new URL("../tool_executor.ts", import.meta.url).href;
const DENO_EXECUTABLE = Deno.execPath();
const DEFAULT_TIMEOUT_SEC = 30;

export async function runLocalToolExecutor(
  req: SandboxExecRequest,
  sandboxConfig: SandboxConfig,
  grantedPermissions: SandboxPermission[],
): Promise<ToolResult> {
  const flags = [
    ...grantedPermissions.map((perm) =>
      permissionToFlag(perm, req.networkAllow)
    ),
    "--allow-env",
  ];
  const timeoutSec = req.timeoutSec ?? sandboxConfig.maxDurationSec ??
    DEFAULT_TIMEOUT_SEC;

  log.debug(
    `LocalProcess: ${req.tool} flags=[${
      flags.join(", ")
    }] timeout=${timeoutSec}s`,
  );

  try {
    const command = new Deno.Command(DENO_EXECUTABLE, {
      args: ["run", ...flags, EXECUTOR_URL, createExecutorInput(req)],
      stdout: "piped",
      stderr: "piped",
      env: filterEnv(resolveEnvFilter(req.execPolicy)),
    });

    const process = command.spawn();
    const timer = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    }, timeoutSec * 1000);

    const { stdout, stderr, success, code } = await process.output();
    clearTimeout(timer);

    return parseExecutorOutput(req.tool, success, code, stdout, stderr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: "",
      error: {
        code: "SANDBOX_SPAWN_ERROR",
        context: { tool: req.tool, message },
        recovery: "Check that 'deno' is in PATH",
      },
    };
  }
}

function createExecutorInput(req: SandboxExecRequest): string {
  return JSON.stringify({
    tool: req.tool,
    args: req.args,
    config: {
      ...req.toolsConfig,
      shell: req.shell,
    },
  });
}

function resolveEnvFilter(execPolicy: ExecPolicy): string[] | undefined {
  return execPolicy.security !== "deny" && "envFilter" in execPolicy
    ? execPolicy.envFilter
    : undefined;
}

function parseExecutorOutput(
  tool: string,
  success: boolean,
  code: number,
  stdout: Uint8Array,
  stderr: Uint8Array,
): ToolResult {
  const out = new TextDecoder().decode(stdout).trim();
  const err = new TextDecoder().decode(stderr).trim();

  if (err) {
    log.debug(`LocalProcess stderr: ${err.slice(0, 500)}`);
  }

  if (!success) {
    return {
      success: false,
      output: "",
      error: {
        code: "SANDBOX_EXIT_ERROR",
        context: {
          tool,
          exitCode: code,
          stderr: err.slice(0, 500),
        },
        recovery: "Check tool permissions and input arguments",
      },
    };
  }

  try {
    return JSON.parse(out) as ToolResult;
  } catch {
    return {
      success: false,
      output: "",
      error: {
        code: "SANDBOX_PARSE_ERROR",
        context: { tool, stdout: out.slice(0, 500) },
        recovery: "Tool executor returned invalid JSON",
      },
    };
  }
}
