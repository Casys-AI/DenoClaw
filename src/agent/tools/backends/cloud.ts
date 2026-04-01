/**
 * DenoSandboxBackend — @deno/sandbox cloud backend (ADR-010).
 *
 * Provisions a Firecracker micro-VM via Deno Deploy, uploads tool_executor.ts
 * and all tools, then executes tool calls via sandbox.sh.
 * Same executor, different isolation envelope.
 *
 * Permission flags (--allow-*) are applied inside the VM for parity with
 * LocalProcessBackend, even though the VM provides OS-level isolation.
 * This keeps the two backends plug-and-play swappable.
 *
 * Lazy init: VM created on first execute(), reused for all subsequent calls.
 * Closed explicitly via close() → sandbox.kill().
 */

import type {
  SandboxBackend,
  SandboxConfig,
  SandboxExecRequest,
  ToolResult,
} from "../../../shared/types.ts";
import { log } from "../../../shared/log.ts";
import { permissionToFlag } from "./permission_flags.ts";
import { DEFAULT_PASSTHROUGH_ENV_KEYS } from "../shell.ts";
import {
  computePermissionIntersection,
  createPermissionDeniedResult,
} from "./sandbox_permissions.ts";
import { ExecPolicyGuard } from "./exec_policy_guard.ts";

const SANDBOX_AGENT_LOCAL_PATH = new URL("../../", import.meta.url).pathname;
const SANDBOX_SHARED_LOCAL_PATH = new URL("../../../shared/", import.meta.url)
  .pathname;
const SANDBOX_DENO_JSON_PATH = new URL("./sandbox_deno.json", import.meta.url)
  .pathname;
const EXECUTOR_SANDBOX_PATH = "src/agent/tools/tool_executor.ts";

interface SandboxCommandResult {
  status: {
    success: boolean;
    code: number;
  };
  stdoutText: string | null;
  stderrText: string | null;
}

interface SandboxProcess {
  output(): Promise<SandboxCommandResult>;
}

interface SandboxFileSystem {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  upload(localPath: string, sandboxPath: string): Promise<void>;
}

interface SandboxInstance {
  spawn(
    command: string,
    options: {
      args: string[];
      stdout: "piped";
      stderr: "piped";
    },
  ): Promise<SandboxProcess>;
  kill(): Promise<void>;
  fs: SandboxFileSystem;
}

export class DenoSandboxBackend implements SandboxBackend {
  readonly kind = "cloud" as const;

  private sandboxConfig: SandboxConfig;
  private token: string;
  private trustGrantedPermissions: boolean;
  private labels?: Record<string, string>;
  private execPolicyGuard: ExecPolicyGuard;
  private sandbox: SandboxInstance | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    sandboxConfig: SandboxConfig,
    token: string,
    options?: {
      trustGrantedPermissions?: boolean;
      labels?: Record<string, string>;
    },
  ) {
    this.sandboxConfig = sandboxConfig;
    this.token = token;
    this.trustGrantedPermissions = options?.trustGrantedPermissions ?? false;
    this.labels = options?.labels;
    this.execPolicyGuard = new ExecPolicyGuard(sandboxConfig);
  }

  async execute(req: SandboxExecRequest): Promise<ToolResult> {
    const { granted, denied } = this.trustGrantedPermissions
      ? { granted: [...req.permissions], denied: [] }
      : computePermissionIntersection(
        req.permissions,
        this.sandboxConfig.allowedPermissions,
      );

    if (denied.length > 0) {
      return createPermissionDeniedResult(req, this.sandboxConfig, denied);
    }

    if (this.execPolicyGuard.shouldEnforce(req)) {
      const command = req.args.command as string;
      const policyResult = await this.execPolicyGuard.enforce(command, req);
      if (policyResult) return policyResult;
    }

    await this.ensureInitialized();

    const input = JSON.stringify({
      tool: req.tool,
      args: req.args,
      config: {
        ...req.toolsConfig,
        shell: req.shell,
      },
    });

    const timeoutSec = req.timeoutSec ?? this.sandboxConfig.maxDurationSec ??
      30;

    // Design 5: apply permission flags for parity with local backend
    const flags = [
      ...granted.map((perm) => permissionToFlag(perm, req.networkAllow)),
      `--allow-env=${DEFAULT_PASSTHROUGH_ENV_KEYS.join(",")}`,
    ];

    log.debug(
      `CloudSandbox: ${req.tool} flags=[${
        flags.join(", ")
      }] timeout=${timeoutSec}s`,
    );

    try {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) =>
        timeoutHandle = setTimeout(
          () => reject(new Error(`sandbox_timeout_${timeoutSec}s`)),
          timeoutSec * 1000,
        )
      );

      const sandbox = this.sandbox;
      if (!sandbox) {
        throw new Error("sandbox_not_initialized");
      }

      const child = await sandbox.spawn("deno", {
        args: ["run", ...flags, EXECUTOR_SANDBOX_PATH, input],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await Promise.race([
        child.output(),
        timeoutPromise,
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }) as SandboxCommandResult;
      const out = result.stdoutText ?? "";
      const stderr = result.stderrText ?? "";

      try {
        return JSON.parse(out.trim()) as ToolResult;
      } catch {
        return {
          success: false,
          output: "",
          error: {
            code: result.status.success
              ? "SANDBOX_PARSE_ERROR"
              : "SANDBOX_EXEC_ERROR",
            context: {
              tool: req.tool,
              exitCode: result.status.code,
              stdout: out.slice(0, 500),
              stderr: stderr.slice(0, 500),
            },
            recovery: result.status.success
              ? "Tool executor returned invalid JSON"
              : "Check tool_executor stderr/stdout for the failing command",
          },
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        output: "",
        error: {
          code: "SANDBOX_EXEC_ERROR",
          context: { tool: req.tool, message: msg },
          recovery: "Check sandbox connectivity and DENOCLAW_SANDBOX_API_TOKEN",
        },
      };
    }
  }

  async close(): Promise<void> {
    if (this.sandbox) {
      try {
        await this.sandbox.kill();
        log.debug("CloudSandbox: VM destroyed");
      } catch (e) {
        log.debug(`CloudSandbox: close error — ${(e as Error).message}`);
      }
      this.sandbox = null;
      this.initPromise = null;
    }
  }

  // ── Lazy initialization ──

  private async ensureInitialized(): Promise<void> {
    if (this.sandbox) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.init().catch((e) => {
      log.error(`CloudSandbox: init failed — ${(e as Error).message}`);
      this.initPromise = null; // allow retry on next call
      throw e;
    });
    await this.initPromise;
  }

  private async init(): Promise<void> {
    log.info("CloudSandbox: provisioning micro-VM...");

    const { Sandbox } = await import("@deno/sandbox");

    const timeoutMin = Math.ceil(
      (this.sandboxConfig.maxDurationSec ?? 300) / 60,
    );

    const sandbox = await Sandbox.create({
      token: this.token,
      allowNet: this.sandboxConfig.networkAllow,
      timeout: `${Math.min(timeoutMin, 30)}m`,
      ...(this.labels ? { labels: this.labels } : {}),
      env: {
        LOG_LEVEL: Deno.env.get("LOG_LEVEL") ?? "info",
        DENOCLAW_EXEC: "1",
      },
    }) as SandboxInstance;

    // Upload tools — kill VM on failure to avoid orphaned VMs
    try {
      await sandbox.fs.mkdir("src", { recursive: true });
      await sandbox.fs.upload(SANDBOX_DENO_JSON_PATH, "./deno.json");
      await sandbox.fs.upload(SANDBOX_AGENT_LOCAL_PATH, "./src");
      await sandbox.fs.upload(SANDBOX_SHARED_LOCAL_PATH, "./src");
    } catch (e) {
      log.error(
        `CloudSandbox: upload failed, killing VM — ${(e as Error).message}`,
      );
      await sandbox.kill().catch(() => {});
      throw e;
    }

    this.sandbox = sandbox;
    log.info("CloudSandbox: VM ready, tools uploaded");
  }
}
