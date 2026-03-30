import type { Config } from "../../config/types.ts";
import type {
  AgentEntry,
  ExecPolicy,
  SandboxPermission,
  ToolResult,
} from "../../shared/types.ts";
import { log } from "../../shared/log.ts";
import type { ToolExecutionPort } from "../tool_execution_port.ts";
import type { BrokerToolRequestMessage } from "../types.ts";
import type { BrokerReplyDispatcher } from "./reply_dispatch.ts";
import type { BrokerTaskPersistence } from "./persistence.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";

const DEFAULT_EXEC_POLICY: ExecPolicy = {
  security: "allowlist",
  allowedCommands: [],
  ask: "on-miss",
  askFallback: "deny",
};

export interface BrokerToolDispatcherDeps {
  config: Config;
  getKv(): Promise<Deno.Kv>;
  toolExecution: ToolExecutionPort;
  tunnelRegistry: TunnelRegistry;
  replyDispatcher: BrokerReplyDispatcher;
  persistence: BrokerTaskPersistence;
  routeToTunnel(ws: WebSocket, msg: BrokerToolRequestMessage): void;
  metrics: {
    recordToolCall(
      agentId: string,
      tool: string,
      success: boolean,
      latencyMs: number,
    ): Promise<void>;
  };
}

export class BrokerToolDispatcher {
  constructor(private readonly deps: BrokerToolDispatcherDeps) {}

  async handleToolRequest(msg: BrokerToolRequestMessage): Promise<void> {
    const req = msg.payload;

    const { granted, denied, agentConfig } = await this.checkToolPermissions(
      msg.from,
      req.tool,
    );

    if (denied.length > 0) {
      const toolPerms = this.resolveToolPermissions(req.tool);
      const agentAllowed = agentConfig.value?.sandbox?.allowedPermissions || [];
      await this.deps.replyDispatcher.sendStructuredError(msg.from, msg.id, {
        code: "SANDBOX_PERMISSION_DENIED",
        context: { tool: req.tool, required: toolPerms, agentAllowed, denied },
        recovery: `Add ${
          JSON.stringify(
            denied,
          )
        } to agent sandbox.allowedPermissions`,
      });
      return;
    }

    const toolStart = performance.now();
    const tunnel = this.deps.tunnelRegistry.findToolSocket(req.tool);
    if (tunnel) {
      this.deps.routeToTunnel(tunnel, msg);
      await this.deps.metrics.recordToolCall(
        msg.from,
        req.tool,
        true,
        performance.now() - toolStart,
      );
      return;
    }

    const approvalResult = await this.resolveBrokerToolApprovalRequirement(
      msg.from,
      req,
      agentConfig.value?.sandbox?.execPolicy,
      this.deps.config.agents?.defaults?.sandbox?.execPolicy,
    );
    if (approvalResult) {
      await this.replyToolResult(msg.from, msg.id, approvalResult);
      await this.deps.metrics.recordToolCall(
        msg.from,
        req.tool,
        false,
        performance.now() - toolStart,
      );
      return;
    }

    try {
      const agentNetwork = agentConfig.value?.sandbox?.networkAllow;
      const defaultNetwork = this.deps.config.agents?.defaults?.sandbox
        ?.networkAllow;
      const maxDuration = agentConfig.value?.sandbox?.maxDurationSec ||
        this.deps.config.agents?.defaults?.sandbox?.maxDurationSec ||
        30;
      const execPolicy = agentConfig.value?.sandbox?.execPolicy ??
        this.deps.config.agents?.defaults?.sandbox?.execPolicy ??
        DEFAULT_EXEC_POLICY;

      log.info(`Sandbox: ${req.tool} permissions=${JSON.stringify(granted)}`);
      const result = await this.deps.toolExecution.executeTool({
        tool: req.tool,
        args: req.args,
        permissions: granted,
        networkAllow: agentNetwork || defaultNetwork,
        timeoutSec: maxDuration,
        execPolicy,
        toolsConfig: { agentId: msg.from },
      });

      this.deps.metrics.recordToolCall(
        msg.from,
        req.tool,
        result.success,
        performance.now() - toolStart,
      );
      this.replyToolResult(msg.from, msg.id, result);
    } catch (error) {
      this.deps.replyDispatcher.sendStructuredError(msg.from, msg.id, {
        code: "SANDBOX_EXEC_FAILED",
        context: { tool: req.tool, message: (error as Error).message },
        recovery:
          "Check DENOCLAW_SANDBOX_API_TOKEN and Sandbox API availability",
      });
    }
  }

  async resolveBrokerToolApprovalRequirement(
    _agentId: string,
    req: { tool: string; args: Record<string, unknown>; taskId?: string },
    agentPolicy?: ExecPolicy,
    defaultPolicy?: ExecPolicy,
  ): Promise<ToolResult | null> {
    if (req.tool !== "shell" || req.args.dry_run === true) {
      return null;
    }

    const command = typeof req.args.command === "string"
      ? req.args.command
      : null;
    if (!command) return null;

    const policy = agentPolicy ?? defaultPolicy ?? DEFAULT_EXEC_POLICY;
    const check = this.deps.toolExecution.checkExecPolicy(command, policy);
    if (check.allowed) return null;

    if (
      req.taskId &&
      check.reason !== "denied" &&
      (policy.ask === "always" || policy.ask === "on-miss") &&
      (await this.deps.persistence.consumeApprovedTaskResume(
        req.taskId,
        command,
      ))
    ) {
      return null;
    }

    if (
      check.reason !== "denied" &&
      (policy.ask === "always" || policy.ask === "on-miss")
    ) {
      return {
        success: false,
        output: "",
        error: {
          code: "EXEC_APPROVAL_REQUIRED",
          context: {
            taskId: req.taskId,
            command,
            binary: check.binary ?? command,
            reason: check.reason ?? "not-in-allowlist",
          },
          recovery:
            "Resume the canonical task with approval metadata to continue",
        },
      };
    }

    return {
      success: false,
      output: "",
      error: {
        code: "EXEC_DENIED",
        context: {
          taskId: req.taskId,
          command,
          binary: check.binary ?? command,
          reason: check.reason ?? "denied",
        },
        recovery: `Add '${
          check.binary ?? command
        }' to execPolicy.allowedCommands or use ask: 'on-miss'`,
      },
    };
  }

  private async checkToolPermissions(
    agentId: string,
    tool: string,
  ): Promise<{
    granted: SandboxPermission[];
    denied: SandboxPermission[];
    agentConfig: Deno.KvEntryMaybe<AgentEntry>;
  }> {
    const kv = await this.deps.getKv();
    const toolPerms = this.resolveToolPermissions(tool);
    const agentConfig = await kv.get<AgentEntry>(["agents", agentId, "config"]);
    const agentAllowed = agentConfig.value?.sandbox?.allowedPermissions || [];

    return {
      granted: toolPerms.filter((permission) =>
        agentAllowed.includes(permission)
      ),
      denied: toolPerms.filter((permission) =>
        !agentAllowed.includes(permission)
      ),
      agentConfig,
    };
  }

  private resolveToolPermissions(tool: string): SandboxPermission[] {
    const tunnelPermissions = this.deps.tunnelRegistry
      .getDeclaredToolPermissions();
    return this.deps.toolExecution.resolveToolPermissions(
      tool,
      tunnelPermissions,
    );
  }

  private async replyToolResult(
    to: string,
    replyToId: string,
    payload: ToolResult,
  ): Promise<void> {
    await this.deps.replyDispatcher.sendReply({
      id: replyToId,
      from: "broker",
      to,
      type: "tool_response",
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}
