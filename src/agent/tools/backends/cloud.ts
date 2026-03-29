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
  SandboxConfig,
  SandboxPermission,
  ToolResult,
} from "../../../shared/types.ts";
import type { SandboxBackend, SandboxExecRequest } from "../../sandbox_types.ts";
import { log } from "../../../shared/log.ts";

const TOOLS_LOCAL_PATH = new URL("../", import.meta.url).pathname;
const TOOLS_SANDBOX_PATH = "/app/tools/";
const EXECUTOR_SANDBOX_PATH = `${TOOLS_SANDBOX_PATH}tool_executor.ts`;

/** Map SandboxPermission → Deno CLI flag (same logic as LocalProcessBackend). */
function permissionToFlag(
  perm: SandboxPermission,
  networkAllow?: string[],
): string {
  switch (perm) {
    case "read":
      return "--allow-read";
    case "write":
      return "--allow-write";
    case "run":
      return "--allow-run";
    case "net": {
      return networkAllow?.length
        ? `--allow-net=${networkAllow.join(",")}`
        : "--allow-net";
    }
    case "env":
      return "--allow-env";
    case "ffi":
      return "--allow-ffi";
  }
}

export class DenoSandboxBackend implements SandboxBackend {
  readonly kind = "cloud" as const;
  readonly supportsFullShell = true;

  private sandboxConfig: SandboxConfig;
  private token: string;
  // deno-lint-ignore no-explicit-any
  private sandbox: any = null;
  private initPromise: Promise<void> | null = null;

  constructor(sandboxConfig: SandboxConfig, token: string) {
    this.sandboxConfig = sandboxConfig;
    this.token = token;
  }

  async execute(req: SandboxExecRequest): Promise<ToolResult> {
    // Design 4: honor security: "deny" even in cloud — it's a business decision, not isolation
    if (req.execPolicy.security === "deny" && req.tool === "shell") {
      return {
        success: false,
        output: "",
        error: {
          code: "EXEC_DENIED",
          context: { tool: req.tool, reason: "security: deny" },
          recovery: "Change execPolicy.security to 'allowlist' or 'full'",
        },
      };
    }

    await this.ensureInitialized();

    const input = JSON.stringify({
      tool: req.tool,
      args: req.args,
      config: req.toolsConfig,
    });

    const timeoutSec = req.timeoutSec ?? this.sandboxConfig.maxDurationSec ??
      30;

    // Design 5: apply permission flags for parity with local backend
    const flags = [
      ...req.permissions.map((p) => permissionToFlag(p, req.networkAllow)),
      "--allow-env=LOG_LEVEL,DENOCLAW_EXEC",
    ];

    log.debug(
      `CloudSandbox: ${req.tool} flags=[${
        flags.join(", ")
      }] timeout=${timeoutSec}s`,
    );

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`sandbox_timeout_${timeoutSec}s`)),
          timeoutSec * 1000,
        )
      );

      const flagStr = flags.join(" ");
      const result = await Promise.race([
        this.sandbox.sh`deno run ${flagStr} ${EXECUTOR_SANDBOX_PATH} ${input}`,
        timeoutPromise,
      ]);
      const out = await result.text();

      try {
        return JSON.parse(out.trim()) as ToolResult;
      } catch {
        return {
          success: false,
          output: "",
          error: {
            code: "SANDBOX_PARSE_ERROR",
            context: { tool: req.tool, stdout: out.slice(0, 500) },
            recovery: "Tool executor returned invalid JSON",
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
          recovery: "Check sandbox connectivity and DENO_DEPLOY_TOKEN",
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
      env: {
        LOG_LEVEL: Deno.env.get("LOG_LEVEL") ?? "info",
        DENOCLAW_EXEC: "1",
      },
    });

    // Upload tools — kill VM on failure to avoid orphaned VMs
    try {
      await sandbox.fs.upload(TOOLS_LOCAL_PATH, TOOLS_SANDBOX_PATH);
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
