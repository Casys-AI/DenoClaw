import type { Config } from "../../config/types.ts";
import type {
  AgentEntry,
  ExecPolicy,
  SandboxPermission,
  ShellConfig,
  ToolResult,
} from "../../shared/types.ts";
import { deriveAgentRuntimeCapabilitiesFromEntry } from "../../shared/runtime_capabilities.ts";
import { log } from "../../shared/log.ts";
import {
  createExecPolicyDeniedError,
  createPrivilegeElevationRequiredError,
} from "../../shared/tool_result_normalization.ts";
import {
  findMatchingPrivilegeElevationGrantResources,
  getPrivilegeElevationGrantSignature,
  listGrantedPermissions,
  type PrivilegeElevationGrant,
  suggestPrivilegeElevationGrantResources,
} from "../../shared/privilege_elevation.ts";
import type { ToolExecutionPort } from "../tool_execution_port.ts";
import type { BrokerToolRequestMessage } from "../types.ts";
import type { BrokerReplyDispatcher } from "./reply_dispatch.ts";
import type { BrokerTaskPersistence } from "./persistence.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";
import type { BrokerCronManager } from "./cron_manager.ts";
import { getAgentDefDir, isDeployEnvironment } from "../../shared/helpers.ts";
import type { ToolExecutorConfig } from "../../shared/types.ts";
import { AgentStore } from "../agent_store.ts";
import {
  type CronToolName,
  executeCronToolRequest,
} from "./cron_tool_actions.ts";

const CRON_TOOLS = new Set<CronToolName>([
  "create_cron",
  "list_crons",
  "delete_cron",
]);

const DEFAULT_EXEC_POLICY: ExecPolicy = {
  security: "allowlist",
  allowedCommands: [],
};

export interface BrokerToolDispatcherDeps {
  config: Config;
  getKv(): Promise<Deno.Kv>;
  toolExecution: ToolExecutionPort;
  tunnelRegistry: TunnelRegistry;
  replyDispatcher: BrokerReplyDispatcher;
  persistence: BrokerTaskPersistence;
  routeToTunnel(ws: WebSocket, msg: BrokerToolRequestMessage): void;
  cronManager?: BrokerCronManager;
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
    const toolStart = performance.now();

    const agentConfig = await this.resolveAgentConfigEntry(msg.from);
    const shell = agentConfig.value?.sandbox?.shell ??
      this.deps.config.agents?.defaults?.sandbox?.shell;
    const approvalResult = this.resolveBrokerToolApprovalRequirement(
      msg.from,
      req,
      agentConfig.value?.sandbox?.execPolicy,
      this.deps.config.agents?.defaults?.sandbox?.execPolicy,
      shell,
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

    const contextId = req.contextId ??
      (req.taskId
        ? await this.deps.persistence.getTaskContextId(req.taskId)
        : undefined);
    const capabilities = deriveAgentRuntimeCapabilitiesFromEntry(
      agentConfig.value ?? undefined,
      this.deps.config.agents?.defaults?.sandbox,
      { privilegeElevationSupported: true },
    );
    const elevationAvailability = await this
      .resolvePrivilegeElevationAvailability(req.taskId, capabilities);
    const taskPrivilegeGrants = req.taskId
      ? await this.deps.persistence.getTaskPrivilegeElevationGrants(req.taskId)
      : [];
    const contextPrivilegeGrants = contextId
      ? await this.deps.persistence.getContextPrivilegeElevationGrants(
        msg.from,
        contextId,
      )
      : [];
    const privilegeGrants = capabilities.sandbox.privilegeElevation.supported
      ? [
        ...contextPrivilegeGrants,
        ...taskPrivilegeGrants,
      ]
      : [];

    const { granted, denied, usedElevatedGrantSignatures } = await this
      .checkToolPermissions(
        msg.from,
        req.tool,
        req.args,
        privilegeGrants,
      );

    if (denied.length > 0) {
      const toolPerms = this.resolveToolPermissions(req.tool);
      const agentAllowed = agentConfig.value?.sandbox?.allowedPermissions ??
        this.deps.config.agents?.defaults?.sandbox?.allowedPermissions ?? [];
      const command =
        req.tool === "shell" && typeof req.args.command === "string"
          ? req.args.command
          : undefined;
      const binary = command ? command.trim().split(/\s+/)[0] : undefined;
      await this.deps.replyDispatcher.sendStructuredError(
        msg.from,
        msg.id,
        createPrivilegeElevationRequiredError({
          tool: req.tool,
          command,
          binary,
          requiredPermissions: toolPerms,
          agentAllowed,
          denied,
          suggestedGrants: suggestPrivilegeElevationGrantResources(
            req.tool,
            req.args,
            denied,
          ),
          capabilities,
          elevationAvailable: elevationAvailability.available,
          elevationReason: elevationAvailability.reason,
        }),
      );
      return;
    }

    if (req.taskId && usedElevatedGrantSignatures.length > 0) {
      await this.deps.persistence.consumeOnceTaskPrivilegeElevationGrants(
        req.taskId,
        usedElevatedGrantSignatures,
      );
    }

    if (CRON_TOOLS.has(req.tool as CronToolName)) {
      const result = await executeCronToolRequest(
        this.deps.cronManager,
        msg.from,
        req.tool as CronToolName,
        req.args,
      );
      await this.replyToolResult(msg.from, msg.id, result);
      await this.deps.metrics.recordToolCall(
        msg.from,
        req.tool,
        result.success,
        performance.now() - toolStart,
      );
      return;
    }

    const toolsConfig = this.resolveToolExecutionConfig(msg.from);
    const shouldBypassTunnel = this.shouldBypassTunnelForWorkspaceTool(
      req.tool,
      toolsConfig,
    );
    const tunnel = shouldBypassTunnel
      ? null
      : this.deps.tunnelRegistry.findToolSocket(req.tool);
    if (tunnel) {
      this.deps.routeToTunnel(tunnel, {
        ...msg,
        payload: {
          ...req,
          execution: {
            ...req.execution,
            shell,
          },
        },
      });
      await this.deps.metrics.recordToolCall(
        msg.from,
        req.tool,
        true,
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
        shell,
        toolsConfig,
        executionContext: {
          agentId: msg.from,
          taskId: req.taskId,
          contextId,
          ownershipScope: contextId ? "context" : "agent",
        },
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

  resolveBrokerToolApprovalRequirement(
    _agentId: string,
    req: { tool: string; args: Record<string, unknown>; taskId?: string },
    agentPolicy?: ExecPolicy,
    defaultPolicy?: ExecPolicy,
    shell?: ShellConfig,
  ): ToolResult | null {
    if (req.tool !== "shell" || req.args.dry_run === true) {
      return null;
    }

    const command = typeof req.args.command === "string"
      ? req.args.command
      : null;
    if (!command) return null;

    const policy = agentPolicy ?? defaultPolicy ?? DEFAULT_EXEC_POLICY;
    const check = this.deps.toolExecution.checkExecPolicy(
      command,
      policy,
      shell,
    );
    if (check.allowed) return null;

    return {
      success: false,
      output: "",
      error: createExecPolicyDeniedError({
        command,
        binary: check.binary ?? command,
        reason: check.reason ?? "denied",
        recovery: check.recovery ??
          `Update execPolicy to allow '${
            check.binary ?? command
          }' or relax execPolicy.security`,
      }),
    };
  }

  private async resolvePrivilegeElevationAvailability(
    taskId: string | undefined,
    capabilities: ReturnType<typeof deriveAgentRuntimeCapabilitiesFromEntry>,
  ): Promise<{
    available: boolean;
    reason?: "no_channel" | "disabled_for_agent";
  }> {
    if (!capabilities.sandbox.privilegeElevation.supported) {
      return { available: false, reason: "disabled_for_agent" };
    }

    if (!taskId) {
      return { available: false, reason: "no_channel" };
    }

    const brokerMetadata = await this.deps.persistence
      .getTaskBrokerMetadataById(
        taskId,
      );
    return brokerMetadata.channel
      ? { available: true }
      : { available: false, reason: "no_channel" };
  }

  private async checkToolPermissions(
    agentId: string,
    tool: string,
    args: Record<string, unknown>,
    privilegeGrants: PrivilegeElevationGrant[] = [],
  ): Promise<{
    granted: SandboxPermission[];
    denied: SandboxPermission[];
    usedElevatedGrantSignatures: string[];
  }> {
    const toolPerms = this.resolveToolPermissions(tool);
    const agentConfig = await this.resolveAgentConfigEntry(agentId);
    const baseAllowed = agentConfig.value?.sandbox?.allowedPermissions ??
      this.deps.config.agents?.defaults?.sandbox?.allowedPermissions ?? [];
    const matchingGrantResources = findMatchingPrivilegeElevationGrantResources(
      privilegeGrants,
      tool,
      args,
      toolPerms,
    );
    const grantedByElevation = listGrantedPermissions(
      matchingGrantResources.map(({ resource }) => resource),
    );
    const agentAllowed = [...new Set([...baseAllowed, ...grantedByElevation])];
    const usedElevatedGrantSignatures = [
      ...new Set(
        matchingGrantResources
          .filter(({ resource }) => !baseAllowed.includes(resource.permission))
          .map(({ grant }) => getPrivilegeElevationGrantSignature(grant)),
      ),
    ];

    return {
      granted: toolPerms.filter((permission) =>
        agentAllowed.includes(permission)
      ),
      denied: toolPerms.filter((permission) =>
        !agentAllowed.includes(permission)
      ),
      usedElevatedGrantSignatures,
    };
  }

  private async resolveAgentConfigEntry(
    agentId: string,
  ): Promise<Deno.KvEntryMaybe<AgentEntry>> {
    const kv = await this.deps.getKv();
    return await new AgentStore(kv).getEntry(agentId);
  }

  private resolveToolExecutionConfig(agentId: string): ToolExecutorConfig {
    if (isDeployEnvironment()) {
      return {
        agentId,
        workspaceBackend: "kv",
      };
    }

    return {
      agentId,
      workspaceBackend: "filesystem",
      workspaceDir: getAgentDefDir(agentId),
    };
  }

  private shouldBypassTunnelForWorkspaceTool(
    tool: string,
    toolsConfig: ToolExecutorConfig,
  ): boolean {
    return (
      (tool === "read_file" || tool === "write_file") &&
      toolsConfig.workspaceBackend === "kv"
    );
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
