import type {
  BrokerFederationMessage,
  BrokerMessage,
  BrokerTaskContinuePayload,
  BrokerTaskQueryPayload,
  BrokerTaskResultPayload,
  BrokerTaskSubmitPayload,
  TunnelCapabilities,
} from "./types.ts";
import {
  extractBrokerContinuationMessage,
  extractBrokerSubmitTaskMessage,
} from "./types.ts";
import type {
  AgentEntry,
  SandboxPermission,
  StructuredError,
  ToolResult,
} from "../shared/types.ts";
import type { ExecPolicy } from "../agent/sandbox_types.ts";
import type { Config } from "../config/types.ts";
import { AuthManager } from "./auth.ts";
import { ProviderManager } from "../llm/manager.ts";
import { MetricsCollector } from "../telemetry/metrics.ts";
import { ConfigError, DenoClawError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import { createSSEResponse } from "./monitoring.ts";
import { log } from "../shared/log.ts";
import { TaskStore } from "../messaging/a2a/tasks.ts";
import {
  assertValidTaskTransition,
  isTerminalTaskState,
  transitionTask,
} from "../messaging/a2a/internal_contract.ts";
import {
  getAwaitedInputMetadata,
  getResumePayloadMetadata,
} from "../messaging/a2a/input_metadata.ts";
import type { Task } from "../messaging/a2a/types.ts";
import {
  type BrokerIdentity,
  createFederationControlRouter,
  type FederatedRoutePolicy,
  FederationDeadLetterNotFoundError,
  type FederationControlEnvelope,
  type FederationControlHandlerMap,
  type FederationRoutingPort,
  FederationService,
  isFederationControlMethod,
  KvFederationAdapter,
  mapInstanceTunnelToCatalog,
} from "./federation/mod.ts";
import {
  assertTunnelRegisterMessage,
  DENOCLAW_TUNNEL_PROTOCOL,
  getAcceptedTunnelProtocol,
  TUNNEL_IDLE_TIMEOUT_SECONDS,
  WS_BUFFERED_AMOUNT_HIGH_WATERMARK,
} from "./tunnel_protocol.ts";
import type { ToolExecutionPort } from "./tool_execution_port.ts";
import { LocalToolExecutionAdapter } from "./adapters/tool_execution_local.ts";
import { DenoSandboxBackend } from "../agent/tools/backends/cloud.ts";

/**
 * Broker server — runs on Deno Deploy.
 *
 * Responsibilities:
 * - LLM Proxy (API keys + CLI tunnel routing)
 * - Canonical A2A task routing between agents
 * - Tunnel hub (WebSocket connections to local machines)
 * - Agent lifecycle (Subhosting + Sandbox CRUD)
 *
 * Transport: KV Queue locally, HTTP/SSE on the network.
 * KV Queue is the current local transport — not the canonical model.
 */
export interface BrokerServerDeps {
  providers?: ProviderManager;
  toolExecution?: ToolExecutionPort;
  metrics?: MetricsCollector;
  kv?: Deno.Kv;
  taskStore?: TaskStore;
}

interface ApprovalGrant {
  kind: "approval";
  approved: true;
  command: string;
  binary: string;
  grantedAt: string;
}

type PendingResumes = Record<string, ApprovalGrant>;

interface BrokerTaskMetadata {
  submittedBy?: string;
  targetAgent?: string;
  request?: Record<string, unknown>;
  pendingResumes?: PendingResumes;
}

interface TunnelConnection {
  ws: WebSocket;
  capabilities: TunnelCapabilities;
  registered: boolean;
}

const DEFAULT_EXEC_POLICY: ExecPolicy = {
  security: "allowlist",
  allowedCommands: [],
  ask: "on-miss",
  askFallback: "deny",
};

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export class BrokerServer {
  private config: Config;
  private auth!: AuthManager;
  private providers: ProviderManager;
  private toolExecution: ToolExecutionPort;
  private metrics: MetricsCollector;
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;
  private taskStore: TaskStore;
  private tunnels = new Map<string, TunnelConnection>();
  private federationAdapter: KvFederationAdapter | null = null;
  private federationRoutingPort: FederationRoutingPort | null = null;
  private federationService: FederationService | null = null;
  private federationControlRouter = createFederationControlRouter(
    this.getFederationControlHandlers(),
  );
  private httpServer?: Deno.HttpServer;

  constructor(config: Config, deps?: BrokerServerDeps) {
    this.config = config;
    this.providers = deps?.providers ?? new ProviderManager(config.providers);
    this.toolExecution = deps?.toolExecution ??
      this.createDefaultToolExecutionAdapter();
    this.metrics = deps?.metrics ?? new MetricsCollector();
    this.kv = deps?.kv ?? null;
    this.ownsKv = !deps?.kv;
    this.taskStore = deps?.taskStore ?? new TaskStore(deps?.kv);
  }

  private createDefaultToolExecutionAdapter(): ToolExecutionPort {
    const sandboxToken = Deno.env.get("DENO_SANDBOX_API_TOKEN") ?? "";
    const defaultSandboxConfig = this.config.agents?.defaults?.sandbox ?? {
      allowedPermissions: [],
    };
    const sandbox = sandboxToken
      ? new DenoSandboxBackend(defaultSandboxConfig, sandboxToken)
      : null;
    return new LocalToolExecutionAdapter({
      sandbox,
      requireSandboxForPermissionedTools: true,
    });
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      try {
        this.kv = await Deno.openKv();
      } catch (e) {
        throw new ConfigError(
          "KV_UNAVAILABLE",
          { cause: (e instanceof Error ? e : new Error(String(e))).message },
          "Check Deno Deploy KV permissions or quota",
        );
      }
    }
    return this.kv;
  }

  private async getAuth(): Promise<AuthManager> {
    if (!this.auth) {
      this.auth = new AuthManager(await this.getKv());
    }
    return this.auth;
  }

  async start(port = 3000): Promise<void> {
    // Warn if no token is configured (ADR-003)
    if (!Deno.env.get("DENOCLAW_API_TOKEN")) {
      log.warn(
        "DENOCLAW_API_TOKEN not set — broker running in unauthenticated mode. Do not use in production.",
      );
    }

    await this.getAuth();

    // HTTP + WebSocket server — all messages arrive via HTTP or WebSocket
    this.httpServer = Deno.serve({ port }, (req) => this.handleHttp(req));

    log.info(`Broker started on port ${port}`);
  }

  /**
   * Handle an incoming broker message (public entry point).
   * Called from HTTP handler, WebSocket tunnel, or local KV Queue.
   */
  async handleIncomingMessage(msg: BrokerMessage): Promise<void> {
    if (msg.to !== "broker") return;
    await this.handleMessage(msg);
  }

  private async handleMessage(msg: BrokerMessage): Promise<void> {
    log.info(`Broker: ${msg.type} from ${msg.from}`);

    try {
      switch (msg.type) {
        case "llm_request":
          await this.handleLLMRequest(msg);
          break;
        case "tool_request":
          await this.handleToolRequest(msg);
          break;
        case "task_submit":
          await this.handleTaskSubmit(msg);
          break;
        case "task_get":
          await this.handleTaskGet(msg);
          break;
        case "task_continue":
          await this.handleTaskContinue(msg);
          break;
        case "task_cancel":
          await this.handleTaskCancel(msg);
          break;
        case "task_result":
          await this.handleTaskResult(msg);
          break;
        case "federation_link_open":
        case "federation_link_ack":
        case "federation_catalog_sync":
        case "federation_route_probe":
        case "federation_link_close":
          await this.handleFederationControlMessage(msg);
          break;
        default:
          log.warn(`Unknown message type: ${msg.type}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log.error(`Message handler failed for ${msg.type} from ${msg.from}`, err);
      try {
        await this.sendStructuredError(msg.from, msg.id, {
          code: "BROKER_ERROR",
          context: {
            messageType: msg.type,
            from: msg.from,
            cause: err.message,
          },
          recovery: "Check broker logs for details",
        });
      } catch (sendErr) {
        log.error(
          "Failed to send error reply to agent (KV unavailable?)",
          sendErr,
        );
      }
    }
  }

  // ── LLM Proxy ───────────────────────────────────────

  private async handleLLMRequest(
    msg: Extract<BrokerMessage, { type: "llm_request" }>,
  ): Promise<void> {
    const req = msg.payload;

    // Check if model is a CLI provider → route to tunnel
    const tunnel = this.findTunnelForProvider(req.model);
    if (tunnel) {
      await this.routeToTunnel(tunnel, msg);
      return;
    }

    // Otherwise: direct API call (broker has the keys)
    const start = performance.now();
    const response = await this.providers.complete(
      req.messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant" | "tool",
        content: m.content,
        name: m.name,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls as undefined,
      })),
      req.model,
      req.temperature,
      req.maxTokens,
      req.tools as undefined,
    );
    const latency = performance.now() - start;

    // Record metrics
    const provider = req.model.split("/")[0] || req.model;
    await this.metrics.recordLLMCall(
      msg.from,
      provider,
      {
        prompt: response.usage?.promptTokens || 0,
        completion: response.usage?.completionTokens || 0,
      },
      latency,
    );

    const reply: BrokerMessage = {
      id: msg.id,
      from: "broker",
      to: msg.from,
      type: "llm_response",
      payload: response,
      timestamp: new Date().toISOString(),
    };

    await this.sendReply(reply);
  }

  // ── Tool routing (ADR-005: permissions par intersection) ─

  /** AX-8: permission check extracted as composable primitive */
  private async checkToolPermissions(
    agentId: string,
    tool: string,
  ): Promise<{
    granted: SandboxPermission[];
    denied: SandboxPermission[];
    agentConfig: Deno.KvEntryMaybe<AgentEntry>;
  }> {
    const kv = await this.getKv();
    const toolPerms = this.resolveToolPermissions(tool);
    const agentConfig = await kv.get<AgentEntry>(["agents", agentId, "config"]);
    const agentAllowed = agentConfig.value?.sandbox?.allowedPermissions || [];

    return {
      granted: toolPerms.filter((p) => agentAllowed.includes(p)),
      denied: toolPerms.filter((p) => !agentAllowed.includes(p)),
      agentConfig,
    };
  }

  private async handleToolRequest(
    msg: Extract<BrokerMessage, { type: "tool_request" }>,
  ): Promise<void> {
    const req = msg.payload;

    // 1. Check permissions (intersection tool × agent) — deny by default (ADR-005)
    const { granted, denied, agentConfig } = await this.checkToolPermissions(
      msg.from,
      req.tool,
    );

    if (denied.length > 0) {
      const toolPerms = this.resolveToolPermissions(req.tool);
      const agentAllowed = agentConfig.value?.sandbox?.allowedPermissions || [];
      await this.sendStructuredError(msg.from, msg.id, {
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

    // 3. Try tunnel first (local tools)
    const toolStart = performance.now();
    const tunnel = this.findTunnelForTool(req.tool);
    if (tunnel) {
      await this.routeToTunnel(tunnel, msg);
      await this.metrics.recordToolCall(
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
      this.config.agents?.defaults?.sandbox?.execPolicy,
    );
    if (approvalResult) {
      await this.replyToolResult(msg.from, msg.id, approvalResult);
      await this.metrics.recordToolCall(
        msg.from,
        req.tool,
        false,
        performance.now() - toolStart,
      );
      return;
    }

    try {
      const agentNetwork = agentConfig.value?.sandbox?.networkAllow;
      const defaultNetwork = this.config.agents?.defaults?.sandbox
        ?.networkAllow;
      const maxDuration = agentConfig.value?.sandbox?.maxDurationSec ||
        this.config.agents?.defaults?.sandbox?.maxDurationSec ||
        30;
      const execPolicy = agentConfig.value?.sandbox?.execPolicy ??
        this.config.agents?.defaults?.sandbox?.execPolicy ??
        DEFAULT_EXEC_POLICY;

      log.info(`Sandbox: ${req.tool} permissions=${JSON.stringify(granted)}`);
      const result = await this.toolExecution.executeTool({
        tool: req.tool,
        args: req.args,
        permissions: granted,
        networkAllow: agentNetwork || defaultNetwork,
        timeoutSec: maxDuration,
        execPolicy,
        toolsConfig: { agentId: msg.from },
      });

      this.metrics.recordToolCall(
        msg.from,
        req.tool,
        result.success,
        performance.now() - toolStart,
      );
      this.replyToolResult(msg.from, msg.id, result);
    } catch (e) {
      this.sendStructuredError(msg.from, msg.id, {
        code: "SANDBOX_EXEC_FAILED",
        context: { tool: req.tool, message: (e as Error).message },
        recovery: "Check DENO_SANDBOX_API_TOKEN and Sandbox API availability",
      });
    }
  }

  private async resolveBrokerToolApprovalRequirement(
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
    const check = this.toolExecution.checkExecPolicy(command, policy);
    if (check.allowed) return null;

    if (
      req.taskId &&
      check.reason !== "denied" &&
      (policy.ask === "always" || policy.ask === "on-miss") &&
      (await this.consumeApprovedTaskResume(req.taskId, command))
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

  private async consumeApprovedTaskResume(
    taskId: string,
    command: string,
  ): Promise<boolean> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return false;

    const brokerMetadata = this.getTaskBrokerMetadata(entry.value);
    const pendingResumes = this.getPendingResumes(brokerMetadata);
    const grantKey = pendingResumes[command]?.approved === true
      ? command
      : pendingResumes["*"]?.approved === true
      ? "*"
      : null;
    if (!grantKey) return false;

    const nextResumes = { ...pendingResumes };
    delete nextResumes[grantKey];
    const nextTask: Task = {
      ...entry.value,
      metadata: {
        ...(entry.value.metadata ?? {}),
        broker: { ...brokerMetadata, pendingResumes: nextResumes },
      },
    };
    // Atomic check+set to prevent TOCTOU: if another request already consumed this grant, commit fails.
    const result = await kv
      .atomic()
      .check(entry)
      .set(["a2a_tasks", taskId], nextTask)
      .commit();
    return result.ok;
  }

  private async replyToolResult(
    to: string,
    replyToId: string,
    payload: ToolResult,
  ): Promise<void> {
    const reply: BrokerMessage = {
      id: replyToId,
      from: "broker",
      to,
      type: "tool_response",
      payload,
      timestamp: new Date().toISOString(),
    };
    await this.sendReply(reply);
  }

  /**
   * Resolve tool permissions (ADR-005).
   * Built-in map = source of truth for known tools.
   * Tunnel-advertised = custom tools that are not in the built-in map.
   */
  private resolveToolPermissions(tool: string): SandboxPermission[] {
    const tunnelPermissions: Record<string, SandboxPermission[]> = {};
    for (const [_, tunnel] of this.tunnels) {
      for (
        const [toolName, perms] of Object.entries(
          tunnel.capabilities.toolPermissions ?? {},
        )
      ) {
        if (!tunnelPermissions[toolName]) {
          tunnelPermissions[toolName] = [...perms];
        }
      }
    }
    return this.toolExecution.resolveToolPermissions(tool, tunnelPermissions);
  }

  // ── Canonical task message handlers ─────────────────

  private async handleTaskSubmit(
    msg: Extract<BrokerMessage, { type: "task_submit" }>,
  ): Promise<void> {
    const task = await this.submitAgentTask(msg.from, msg.payload);
    await this.sendTaskResult(msg.from, msg.id, task);
  }

  private async handleTaskGet(
    msg: Extract<BrokerMessage, { type: "task_get" }>,
  ): Promise<void> {
    const task = await this.getTask(msg.payload);
    await this.sendTaskResult(msg.from, msg.id, task);
  }

  private async handleTaskContinue(
    msg: Extract<BrokerMessage, { type: "task_continue" }>,
  ): Promise<void> {
    const task = await this.continueAgentTask(msg.from, msg.payload);
    await this.sendTaskResult(msg.from, msg.id, task);
  }

  private async handleTaskCancel(
    msg: Extract<BrokerMessage, { type: "task_cancel" }>,
  ): Promise<void> {
    const task = await this.cancelTask(msg.payload);
    await this.sendTaskResult(msg.from, msg.id, task);
  }

  private async handleTaskResult(
    msg: Extract<BrokerMessage, { type: "task_result" }>,
  ): Promise<void> {
    const task = await this.recordTaskResult(msg.from, msg.payload);
    await this.sendTaskResult(msg.from, msg.id, task);
  }

  async submitAgentTask(
    fromAgentId: string,
    payload: BrokerTaskSubmitPayload,
  ): Promise<Task> {
    await this.assertPeerAccess(fromAgentId, payload.targetAgent);

    const taskMessage = extractBrokerSubmitTaskMessage(payload);

    const task = await this.taskStore.create(
      payload.taskId,
      taskMessage,
      payload.contextId,
    );

    const persistedTask = await this.persistTaskMetadata(task, {
      submittedBy: fromAgentId,
      targetAgent: payload.targetAgent,
      ...(payload.metadata ? { request: payload.metadata } : {}),
    });

    await this.routeBrokerMessageToAgent(payload.targetAgent, {
      id: generateId(),
      from: fromAgentId,
      to: payload.targetAgent,
      type: "task_submit",
      payload: {
        ...payload,
        taskId: persistedTask.id,
        taskMessage,
        contextId: persistedTask.contextId,
      },
      timestamp: new Date().toISOString(),
    });

    return persistedTask;
  }

  async getTask(payload: BrokerTaskQueryPayload): Promise<Task | null> {
    return await this.taskStore.get(payload.taskId);
  }

  async continueAgentTask(
    fromAgentId: string,
    payload: BrokerTaskContinuePayload,
  ): Promise<Task | null> {
    const existing = await this.taskStore.get(payload.taskId);
    if (!existing) return null;

    const brokerMetadata = this.getTaskBrokerMetadata(existing);
    const targetAgentId = typeof brokerMetadata.targetAgent === "string"
      ? brokerMetadata.targetAgent
      : undefined;
    if (!targetAgentId) {
      throw new DenoClawError(
        "TASK_TARGET_UNKNOWN",
        { taskId: existing.id, brokerMetadata },
        "Broker task metadata is missing targetAgent",
      );
    }
    await this.assertPeerAccess(fromAgentId, targetAgentId);

    if (existing.status.state !== "INPUT_REQUIRED") {
      throw new DenoClawError(
        "TASK_NOT_WAITING_FOR_INPUT",
        { taskId: existing.id, state: existing.status.state },
        "Only INPUT_REQUIRED tasks can be resumed through broker continuation",
      );
    }

    const continuationMessage = extractBrokerContinuationMessage(payload);
    const resume = getResumePayloadMetadata({ metadata: payload.metadata });
    if (resume?.approved === false) {
      const rejected = transitionTask(existing, "REJECTED", {
        statusMessage: continuationMessage,
      });
      rejected.history = [...existing.history, continuationMessage];
      await this.writeTask(rejected);
      return rejected;
    }

    let updated = existing;
    if (resume?.approved === true) {
      const awaitedInput = getAwaitedInputMetadata(existing.status);
      const command = awaitedInput?.kind === "approval"
        ? awaitedInput.command
        : "*";
      const binary = awaitedInput?.kind === "approval" && awaitedInput.binary
        ? awaitedInput.binary
        : command;
      const pendingResumes = this.getPendingResumes(brokerMetadata);
      const grant: ApprovalGrant = {
        kind: "approval",
        approved: true,
        command,
        binary,
        grantedAt: new Date().toISOString(),
      };
      updated = await this.persistTaskMetadata(existing, {
        ...brokerMetadata,
        pendingResumes: { ...pendingResumes, [command]: grant },
      });
    }

    await this.routeBrokerMessageToAgent(targetAgentId, {
      id: generateId(),
      from: fromAgentId,
      to: targetAgentId,
      type: "task_continue",
      payload: { ...payload, continuationMessage },
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  async cancelTask(payload: BrokerTaskQueryPayload): Promise<Task | null> {
    return await this.taskStore.cancel(payload.taskId);
  }

  async recordTaskResult(
    fromAgentId: string,
    payload: BrokerTaskResultPayload,
  ): Promise<Task | null> {
    const incomingTask = payload.task;
    if (!incomingTask) return null;

    const existing = await this.taskStore.get(incomingTask.id);
    if (!existing) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: incomingTask.id, fromAgentId },
        "Submit the task through the broker before reporting a result",
      );
    }

    const brokerMetadata = this.getTaskBrokerMetadata(existing);
    const targetAgentId = typeof brokerMetadata.targetAgent === "string"
      ? brokerMetadata.targetAgent
      : undefined;
    if (!targetAgentId) {
      throw new DenoClawError(
        "TASK_TARGET_UNKNOWN",
        { taskId: existing.id, brokerMetadata },
        "Broker task metadata is missing targetAgent",
      );
    }
    if (targetAgentId !== fromAgentId) {
      throw new DenoClawError(
        "TASK_RESULT_FORBIDDEN",
        { taskId: existing.id, expected: targetAgentId, actual: fromAgentId },
        `Only \"${targetAgentId}\" can report the result for task \"${existing.id}\"`,
      );
    }
    if (incomingTask.contextId !== existing.contextId) {
      throw new DenoClawError(
        "TASK_CONTEXT_MISMATCH",
        {
          taskId: existing.id,
          expected: existing.contextId,
          actual: incomingTask.contextId,
        },
        "Preserve the canonical task/context correlation ids when reporting results",
      );
    }

    if (existing.status.state !== incomingTask.status.state) {
      if (isTerminalTaskState(existing.status.state)) {
        throw new DenoClawError(
          "TASK_ALREADY_TERMINAL",
          {
            taskId: existing.id,
            existingState: existing.status.state,
            incomingState: incomingTask.status.state,
          },
          "Task is already terminal; ignore duplicate terminal updates",
        );
      }
      assertValidTaskTransition(
        existing.status.state,
        incomingTask.status.state,
      );
    }

    const persisted: Task = {
      ...incomingTask,
      metadata: {
        ...(incomingTask.metadata ?? {}),
        broker: brokerMetadata,
      },
    };

    await this.writeTask(persisted);
    return persisted;
  }

  private async persistTaskMetadata(
    task: Task,
    brokerMetadata: BrokerTaskMetadata,
  ): Promise<Task> {
    const nextTask: Task = {
      ...task,
      metadata: {
        ...(task.metadata ?? {}),
        broker: brokerMetadata,
      },
    };
    await this.writeTask(nextTask);
    return nextTask;
  }

  private async writeTask(task: Task): Promise<void> {
    const kv = await this.getKv();
    await kv.set(["a2a_tasks", task.id], task);
  }

  private getTaskBrokerMetadata(task: Task): BrokerTaskMetadata {
    const metadata = task.metadata?.broker;
    return typeof metadata === "object" && metadata !== null
      ? (metadata as BrokerTaskMetadata)
      : {};
  }

  private getPendingResumes(
    brokerMetadata: BrokerTaskMetadata,
  ): PendingResumes {
    return brokerMetadata.pendingResumes ?? {};
  }

  private async assertPeerAccess(
    fromAgentId: string,
    targetAgentId: string,
  ): Promise<void> {
    const kv = await this.getKv();

    const senderConfig = await kv.get<AgentEntry>([
      "agents",
      fromAgentId,
      "config",
    ]);
    const targetConfig = await kv.get<AgentEntry>([
      "agents",
      targetAgentId,
      "config",
    ]);

    const senderPeers = senderConfig.value?.peers || [];
    if (!senderPeers.includes(targetAgentId) && !senderPeers.includes("*")) {
      throw new DenoClawError(
        "PEER_NOT_ALLOWED",
        { from: fromAgentId, to: targetAgentId, senderPeers },
        `Add "${targetAgentId}" to ${fromAgentId}.peers`,
      );
    }

    const targetAccept = targetConfig.value?.acceptFrom || [];
    if (!targetAccept.includes(fromAgentId) && !targetAccept.includes("*")) {
      throw new DenoClawError(
        "PEER_REJECTED",
        {
          from: fromAgentId,
          to: targetAgentId,
          targetAcceptFrom: targetAccept,
        },
        `Add "${fromAgentId}" to ${targetAgentId}.acceptFrom`,
      );
    }
  }

  private async routeBrokerMessageToAgent(
    targetAgentId: string,
    message: Extract<
      BrokerMessage,
      {
        type: "task_submit" | "task_continue";
      }
    >,
  ): Promise<void> {
    await this.metrics.recordAgentMessage(message.from, targetAgentId);

    const tunnel = this.findTunnelByAgentId(targetAgentId);
    if (tunnel) {
      this.routeToTunnel(tunnel, message);
      log.info(
        `A2A routed via tunnel: ${message.from} → ${targetAgentId} (${message.type})`,
      );
      return;
    }

    // Local-mode transport: canonical task messages are delivered over KV Queue
    // when no WebSocket tunnel is active for the target agent.
    const kv = await this.getKv();
    await kv.enqueue(message);
    log.info(
      `A2A routed via KV Queue: ${message.from} → ${targetAgentId} (${message.type})`,
    );
  }

  // ── Federation control-plane ───────────────────────────

  private async getFederationAdapter(): Promise<KvFederationAdapter> {
    if (this.federationAdapter) return this.federationAdapter;
    this.federationAdapter = new KvFederationAdapter(await this.getKv());
    return this.federationAdapter;
  }

  private async getFederationService(): Promise<FederationService> {
    if (this.federationService) return this.federationService;
    const adapter = await this.getFederationAdapter();
    this.federationService = new FederationService(
      adapter,
      adapter,
      adapter,
      adapter,
      this.createFederationRoutingPort(),
      adapter,
      adapter,
    );
    return this.federationService;
  }

  private createFederationRoutingPort(): FederationRoutingPort {
    if (this.federationRoutingPort) return this.federationRoutingPort;
    this.federationRoutingPort = {
      resolveTarget: async (task, _policy, correlation) => {
        const tunnel = this.findTunnelForRemoteBroker(correlation.remoteBrokerId);
        const advertisedAgents = tunnel?.capabilities.agents ?? [];
        if (!tunnel) {
          return {
            kind: "remote",
            remoteBrokerId: correlation.remoteBrokerId,
            reason: "remote_broker_unavailable",
          };
        }
        if (
          advertisedAgents.length > 0 &&
          !advertisedAgents.includes(task.targetAgent)
        ) {
          return {
            kind: "remote",
            remoteBrokerId: correlation.remoteBrokerId,
            reason: "target_not_advertised_by_remote_broker",
          };
        }
        return {
          kind: "remote",
          remoteBrokerId: correlation.remoteBrokerId,
          reason: "federation_task_submit",
        };
      },
      forwardTask: async (task, remoteBrokerId, correlation) => {
        const taskMessage = extractBrokerSubmitTaskMessage(task);
        const localBrokerId = correlation.linkId.split(":")[0] || "broker";
        const remoteTunnel = this.findTunnelForRemoteBroker(remoteBrokerId);
        if (!remoteTunnel) {
          throw new Error(
            `federation_forward_failed:${remoteBrokerId}:remote_broker_unavailable`,
          );
        }
        const advertisedAgents = remoteTunnel.capabilities.agents ?? [];
        if (
          advertisedAgents.length > 0 &&
          !advertisedAgents.includes(task.targetAgent)
        ) {
          throw new Error(
            `federation_forward_failed:${remoteBrokerId}:target_not_advertised`,
          );
        }
        try {
          this.routeToTunnel(remoteTunnel.ws, {
            id: generateId(),
            from: localBrokerId,
            to: task.targetAgent,
            type: "task_submit",
            payload: {
              ...task,
              taskId: correlation.taskId,
              contextId: correlation.contextId,
              taskMessage,
            },
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          throw new Error(
            `federation_forward_failed:${remoteBrokerId}:${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    };
    return this.federationRoutingPort;
  }

  private getFederationControlHandlers(): FederationControlHandlerMap {
    const requireNonEmptyString = (
      value: unknown,
      field: string,
      messageType: BrokerMessage["type"],
    ): string => {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `Invalid ${messageType} payload: ${field} must be a non-empty string`,
        );
      }
      return value;
    };

    return {
      federation_link_open: async (envelope) => {
        const payload = envelope.payload as Record<string, unknown>;
        const linkId = requireNonEmptyString(
          payload.linkId,
          "linkId",
          envelope.type,
        );
        const localBrokerId = requireNonEmptyString(
          payload.localBrokerId,
          "localBrokerId",
          envelope.type,
        );
        const remoteBrokerId = requireNonEmptyString(
          payload.remoteBrokerId,
          "remoteBrokerId",
          envelope.type,
        );
        const traceId = requireNonEmptyString(
          payload.traceId,
          "traceId",
          envelope.type,
        );
        const service = await this.getFederationService();
        await service.openLink({
          linkId,
          localBrokerId,
          remoteBrokerId,
          requestedBy: envelope.from,
          traceId,
        });

        const ack: Extract<BrokerMessage, { type: "federation_link_ack" }> = {
          id: envelope.id,
          from: "broker",
          to: envelope.from,
          type: "federation_link_ack",
          payload: {
            linkId,
            remoteBrokerId,
            accepted: true,
            traceId,
          },
          timestamp: new Date().toISOString(),
        };
        await this.sendReply(ack);
      },
      federation_link_ack: async (envelope) => {
        const payload = envelope.payload as Record<string, unknown>;
        const linkId = requireNonEmptyString(
          payload.linkId,
          "linkId",
          envelope.type,
        );
        const remoteBrokerId = requireNonEmptyString(
          payload.remoteBrokerId,
          "remoteBrokerId",
          envelope.type,
        );
        const traceId = requireNonEmptyString(
          payload.traceId,
          "traceId",
          envelope.type,
        );
        if (typeof payload.accepted !== "boolean") {
          throw new Error(
            `Invalid ${envelope.type} payload: accepted must be a boolean`,
          );
        }
        const service = await this.getFederationService();
        await service.acknowledgeLink(
          {
            linkId,
            remoteBrokerId,
            traceId,
          },
          payload.accepted,
        );
      },
      federation_catalog_sync: async (envelope) => {
        const payload = envelope.payload as Record<string, unknown>;
        const remoteBrokerId = requireNonEmptyString(
          payload.remoteBrokerId,
          "remoteBrokerId",
          envelope.type,
        );
        const traceId = requireNonEmptyString(
          payload.traceId,
          "traceId",
          envelope.type,
        );
        const agents = Array.isArray(payload.agents)
          ? payload.agents.filter((agent): agent is string =>
            typeof agent === "string"
          )
          : null;
        if (!agents) {
          throw new Error(
            `Invalid ${envelope.type} payload: agents must be a string[]`,
          );
        }
        const service = await this.getFederationService();
        await service.syncCatalog(
          remoteBrokerId,
          agents.map((agentId) => ({
            remoteBrokerId,
            agentId,
            card: {},
            capabilities: [],
            visibility: "public",
          })),
          {
            remoteBrokerId,
            traceId,
          },
        );
      },
      federation_route_probe: async (envelope) => {
        const payload = envelope.payload as Record<string, unknown>;
        const remoteBrokerId = requireNonEmptyString(
          payload.remoteBrokerId,
          "remoteBrokerId",
          envelope.type,
        );
        const targetAgent = requireNonEmptyString(
          payload.targetAgent,
          "targetAgent",
          envelope.type,
        );
        const taskId = requireNonEmptyString(
          payload.taskId,
          "taskId",
          envelope.type,
        );
        const contextId = requireNonEmptyString(
          payload.contextId,
          "contextId",
          envelope.type,
        );
        const traceId = requireNonEmptyString(
          payload.traceId,
          "traceId",
          envelope.type,
        );

        const service = await this.getFederationService();
        const result = await service.probeRoute({
          requesterBrokerId: envelope.from,
          remoteBrokerId,
          targetAgent,
          taskId,
          contextId,
          traceId,
        });

        const reply: Extract<BrokerMessage, { type: "federation_link_ack" }> = {
          id: envelope.id,
          from: "broker",
          to: envelope.from,
          type: "federation_link_ack",
          payload: {
            linkId: result.linkId,
            remoteBrokerId,
            accepted: result.accepted,
            traceId,
            reason: result.reason,
          },
          timestamp: new Date().toISOString(),
        };
        await this.sendReply(reply);
      },
      federation_link_close: async (envelope) => {
        const payload = envelope.payload as Record<string, unknown>;
        const linkId = requireNonEmptyString(
          payload.linkId,
          "linkId",
          envelope.type,
        );
        const remoteBrokerId = requireNonEmptyString(
          payload.remoteBrokerId,
          "remoteBrokerId",
          envelope.type,
        );
        const traceId = requireNonEmptyString(
          payload.traceId,
          "traceId",
          envelope.type,
        );
        const service = await this.getFederationService();
        await service.closeLink({ linkId, remoteBrokerId, traceId });
      },
    };
  }

  private async handleFederationControlMessage(
    msg: BrokerFederationMessage,
  ): Promise<void> {
    if (!isFederationControlMethod(msg.type)) {
      throw new DenoClawError(
        "FEDERATION_METHOD_INVALID",
        { type: msg.type },
        "Use federation control-plane method names",
      );
    }
    const envelope: FederationControlEnvelope = {
      id: msg.id,
      from: msg.from,
      type: msg.type,
      payload: msg.payload,
      timestamp: msg.timestamp,
    };
    await this.federationControlRouter(envelope);
  }

  // ── Tunnel management ───────────────────────────────

  private findTunnelForProvider(_model: string): WebSocket | null {
    // CLI providers now run on the agent's VPS, not via tunnel.
    // Tunnels are for tools and instance-to-instance routing.
    return null;
  }

  private findTunnelForTool(tool: string): WebSocket | null {
    for (const [_, t] of this.tunnels) {
      if (t.registered && t.capabilities.tools.includes(tool)) {
        return t.ws;
      }
    }
    return null;
  }

  private findTunnelForAgent(agentId: string): WebSocket | null {
    for (const [_, t] of this.tunnels) {
      if (
        t.registered &&
        t.capabilities.type === "instance" &&
        t.capabilities.agents?.includes(agentId)
      ) {
        return t.ws;
      }
    }
    return null;
  }

  private findTunnelForRemoteBroker(
    remoteBrokerId: string,
  ): TunnelConnection | null {
    const entry = this.tunnels.get(remoteBrokerId);
    if (
      entry?.registered &&
      entry.capabilities.type === "instance"
    ) {
      return entry;
    }
    return null;
  }

  private routeToTunnel(ws: WebSocket, msg: BrokerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new DenoClawError(
        "TUNNEL_NOT_OPEN",
        {
          readyState: ws.readyState,
          msgId: msg.id,
        },
        "Tunnel disconnected. Reconnect and retry.",
      );
    }
    if (ws.bufferedAmount > WS_BUFFERED_AMOUNT_HIGH_WATERMARK) {
      throw new DenoClawError(
        "TUNNEL_BACKPRESSURE",
        {
          bufferedAmount: ws.bufferedAmount,
          maxBufferedAmount: WS_BUFFERED_AMOUNT_HIGH_WATERMARK,
          msgId: msg.id,
        },
        "Tunnel is saturated. Retry after the relay drains pending messages.",
      );
    }
    ws.send(JSON.stringify(msg));
  }

  private async handleTunnelMessage(
    tunnelId: string,
    data: string,
  ): Promise<void> {
    let msg: BrokerMessage;
    try {
      msg = JSON.parse(data) as BrokerMessage;
    } catch {
      log.error(`Malformed JSON from tunnel ${tunnelId}, message dropped`, {
        preview: data.slice(0, 200),
      });
      return;
    }
    try {
      await this.handleMessage(msg);
    } catch (e) {
      log.error(`Failed to handle tunnel message from ${tunnelId}`, e);
    }
  }

  // ── HTTP + WebSocket (ADR-003: auth built in) ───────

  private async handleHttp(req: Request): Promise<Response> {
    try {
      return await this.handleHttpInner(req);
    } catch (e) {
      log.error("Unhandled HTTP error", e);
      return Response.json(
        { error: { code: "INTERNAL_ERROR", recovery: "Check broker logs" } },
        { status: 500 },
      );
    }
  }

  private async handleHttpInner(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Root — public, no auth
    if (url.pathname === "/") {
      return new Response("DenoClaw Broker");
    }

    // Health — public (monitoring)
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        tunnels: [...this.tunnels.keys()],
        tunnelCount: this.tunnels.size,
      });
    }

    // Tunnel WebSocket — auth via invite token (ADR-003)
    if (url.pathname === "/tunnel") {
      return await this.handleTunnelUpgrade(req);
    }

    // Invite token generation — admin endpoint
    if (req.method === "POST" && url.pathname === "/auth/invite") {
      const auth = await this.getAuth();
      const authResult = await auth.checkRequest(req);
      if (!authResult.ok) {
        return Response.json(
          {
            error: { code: authResult.code, recovery: authResult.recovery },
          },
          { status: 401 },
        );
      }
      const body = (await req.json().catch(() => ({}))) as {
        tunnelId?: string;
      };
      const invite = await auth.generateInviteToken(body.tunnelId);
      return Response.json({
        token: invite.token,
        expiresAt: invite.expiresAt,
      });
    }

    // All other endpoints require auth (ADR-003)
    const auth = await this.getAuth();
    const authResult = await auth.checkRequest(req);
    if (!authResult.ok) {
      return Response.json(
        { error: { code: authResult.code, recovery: authResult.recovery } },
        { status: 401 },
      );
    }

    // Stats endpoint — per-agent metrics
    if (url.pathname === "/stats") {
      const agentId = url.searchParams.get("agent");
      if (agentId) {
        return Response.json(await this.metrics.getAgentMetrics(agentId));
      }
      return Response.json(await this.metrics.getSummary());
    }

    // Detailed per-agent stats
    if (url.pathname === "/stats/agents") {
      return Response.json(await this.metrics.getAllMetrics());
    }

    // SSE stream for dashboard real-time updates
    if (url.pathname === "/events") {
      const kv = await this.getKv();
      const agentIds = [...this.tunnels.values()]
        .filter((t) => t.registered && t.capabilities.agents)
        .flatMap((t) => t.capabilities.agents ?? []);
      return createSSEResponse(kv, agentIds);
    }

    if (req.method === "GET" && url.pathname === "/federation/links") {
      const adapter = await this.getFederationAdapter();
      return Response.json(await adapter.listLinks());
    }

    if (req.method === "GET" && url.pathname === "/federation/catalog") {
      const remoteBrokerId = url.searchParams.get("remoteBrokerId");
      if (!remoteBrokerId) {
        return Response.json(
          {
            error: {
              code: "MISSING_REMOTE_BROKER_ID",
              recovery: "Add ?remoteBrokerId=<broker-id>",
            },
          },
          { status: 400 },
        );
      }
      const adapter = await this.getFederationAdapter();
      return Response.json(
        await adapter.listRemoteAgents(remoteBrokerId, {
          remoteBrokerId,
          traceId: crypto.randomUUID(),
        }),
      );
    }

    if (req.method === "GET" && url.pathname === "/federation/stats") {
      const remoteBrokerId = url.searchParams.get("remoteBrokerId") ??
        undefined;
      const adapter = await this.getFederationAdapter();
      return Response.json(await adapter.getFederationStats(remoteBrokerId));
    }

    if (req.method === "GET" && url.pathname === "/federation/dead-letters") {
      const remoteBrokerId = url.searchParams.get("remoteBrokerId") ??
        undefined;
      const adapter = await this.getFederationAdapter();
      const deadLetters = await adapter.listDeadLetters(remoteBrokerId);
      deadLetters.sort((left, right) => right.movedAt.localeCompare(left.movedAt));
      return Response.json(deadLetters);
    }

    if (
      req.method === "POST" &&
      url.pathname === "/federation/dead-letter/replay"
    ) {
      const body = (await req.json().catch(() => null)) as {
        remoteBrokerId?: string;
        deadLetterId?: string;
        maxAttempts?: number;
        baseBackoffMs?: number;
        maxBackoffMs?: number;
      } | null;
      const invalidAttempts = body?.maxAttempts !== undefined &&
        (!Number.isInteger(body.maxAttempts) || body.maxAttempts <= 0);
      const invalidBaseBackoff = body?.baseBackoffMs !== undefined &&
        (!Number.isFinite(body.baseBackoffMs) || body.baseBackoffMs < 0);
      const invalidMaxBackoff = body?.maxBackoffMs !== undefined &&
        (!Number.isFinite(body.maxBackoffMs) || body.maxBackoffMs < 0);
      const invalidBackoffRange = body?.baseBackoffMs !== undefined &&
        body?.maxBackoffMs !== undefined &&
        body.baseBackoffMs > body.maxBackoffMs;
      if (
        !body ||
        typeof body.remoteBrokerId !== "string" ||
        body.remoteBrokerId.length === 0 ||
        typeof body.deadLetterId !== "string" ||
        body.deadLetterId.length === 0 ||
        invalidAttempts ||
        invalidBaseBackoff ||
        invalidMaxBackoff ||
        invalidBackoffRange
      ) {
        return Response.json(
          {
            error: {
              code: "INVALID_DEAD_LETTER_REPLAY_REQUEST",
              recovery:
                "Provide { remoteBrokerId, deadLetterId, maxAttempts?, baseBackoffMs?, maxBackoffMs? } with positive numeric overrides",
            },
          },
          { status: 400 },
        );
      }

      const service = await this.getFederationService();
      const traceId = crypto.randomUUID();
      try {
        const result = await service.replayDeadLetter({
          remoteBrokerId: body.remoteBrokerId,
          deadLetterId: body.deadLetterId,
          traceId,
          maxAttempts: body.maxAttempts,
          baseBackoffMs: body.baseBackoffMs,
          maxBackoffMs: body.maxBackoffMs,
        });
        return Response.json({ ok: true, traceId, result });
      } catch (error) {
        if (error instanceof FederationDeadLetterNotFoundError) {
          return Response.json(
            {
              error: {
                code: "FEDERATION_DEAD_LETTER_NOT_FOUND",
                recovery: "Refresh the dead-letter list and retry replay",
              },
            },
            { status: 404 },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return Response.json(
          {
            error: {
              code: "FEDERATION_DEAD_LETTER_REPLAY_FAILED",
              cause: message,
              recovery:
                "Inspect the dead-letter entry and broker logs before retrying",
            },
          },
          { status: 500 },
        );
      }
    }

    if (req.method === "GET" && url.pathname === "/federation/policy") {
      const brokerId = url.searchParams.get("brokerId");
      if (!brokerId) {
        return Response.json(
          {
            error: {
              code: "MISSING_BROKER_ID",
              recovery: "Add ?brokerId=<broker-id>",
            },
          },
          { status: 400 },
        );
      }
      const adapter = await this.getFederationAdapter();
      return Response.json(
        await adapter.getRoutePolicy(brokerId, {
          remoteBrokerId: brokerId,
          traceId: crypto.randomUUID(),
        }),
      );
    }

    if (req.method === "PUT" && url.pathname === "/federation/policy") {
      const body = (await req
        .json()
        .catch(() => null)) as FederatedRoutePolicy | null;
      if (
        !body ||
        typeof body.policyId !== "string" ||
        body.policyId.length === 0
      ) {
        return Response.json(
          {
            error: {
              code: "INVALID_POLICY",
              recovery: "Provide a valid FederatedRoutePolicy JSON body",
            },
          },
          { status: 400 },
        );
      }
      const adapter = await this.getFederationAdapter();
      await adapter.setRoutePolicy(body.policyId, body, {
        remoteBrokerId: body.policyId,
        traceId: crypto.randomUUID(),
      });
      return Response.json({ ok: true, policyId: body.policyId });
    }

    if (req.method === "GET" && url.pathname === "/federation/identities") {
      const service = await this.getFederationService();
      return Response.json(await service.listIdentities());
    }

    if (req.method === "GET" && url.pathname === "/federation/identity") {
      const brokerId = url.searchParams.get("brokerId");
      if (!brokerId) {
        return Response.json(
          {
            error: {
              code: "MISSING_BROKER_ID",
              recovery: "Add ?brokerId=<broker-id>",
            },
          },
          { status: 400 },
        );
      }
      const service = await this.getFederationService();
      return Response.json(await service.getIdentity(brokerId));
    }

    if (req.method === "PUT" && url.pathname === "/federation/identity") {
      const body = (await req
        .json()
        .catch(() => null)) as BrokerIdentity | null;
      if (
        !body ||
        typeof body.brokerId !== "string" ||
        body.brokerId.length === 0
      ) {
        return Response.json(
          {
            error: {
              code: "INVALID_IDENTITY",
              recovery: "Provide a valid BrokerIdentity JSON body",
            },
          },
          { status: 400 },
        );
      }
      const service = await this.getFederationService();
      await service.upsertIdentity(body);
      return Response.json({ ok: true, brokerId: body.brokerId });
    }

    if (req.method === "DELETE" && url.pathname === "/federation/identity") {
      const brokerId = url.searchParams.get("brokerId");
      if (!brokerId) {
        return Response.json(
          {
            error: {
              code: "MISSING_BROKER_ID",
              recovery: "Add ?brokerId=<broker-id>",
            },
          },
          { status: 400 },
        );
      }
      const service = await this.getFederationService();
      await service.revokeIdentity(brokerId);
      return Response.json({ ok: true, brokerId });
    }

    if (
      req.method === "POST" &&
      url.pathname === "/federation/identity/rotate"
    ) {
      const body = (await req.json().catch(() => null)) as {
        brokerId?: string;
        nextPublicKey?: string;
      } | null;
      if (
        !body ||
        typeof body.brokerId !== "string" ||
        body.brokerId.length === 0 ||
        typeof body.nextPublicKey !== "string" ||
        body.nextPublicKey.length === 0
      ) {
        return Response.json(
          {
            error: {
              code: "INVALID_ROTATE_IDENTITY_REQUEST",
              recovery: "Provide { brokerId, nextPublicKey }",
            },
          },
          { status: 400 },
        );
      }

      const service = await this.getFederationService();
      const identity = await service.rotateIdentityKey(
        body.brokerId,
        body.nextPublicKey,
      );
      return Response.json({ ok: true, identity });
    }

    if (
      req.method === "POST" &&
      url.pathname === "/federation/session/rotate"
    ) {
      const body = (await req.json().catch(() => null)) as {
        linkId?: string;
        ttlSeconds?: number;
      } | null;
      const invalidTtl = body?.ttlSeconds !== undefined &&
        (!Number.isFinite(body.ttlSeconds) || body.ttlSeconds <= 0);
      if (
        !body ||
        typeof body.linkId !== "string" ||
        body.linkId.length === 0 ||
        invalidTtl
      ) {
        return Response.json(
          {
            error: {
              code: "INVALID_ROTATE_SESSION_REQUEST",
              recovery: "Provide { linkId, ttlSeconds? } with ttlSeconds > 0",
            },
          },
          { status: 400 },
        );
      }
      const service = await this.getFederationService();
      const adapter = await this.getFederationAdapter();
      const link = (await adapter.listLinks()).find((entry) =>
        entry.linkId === body.linkId
      );
      if (!link) {
        return Response.json(
          {
            error: {
              code: "FEDERATION_LINK_NOT_FOUND",
              recovery: "Create the link before rotating its session",
            },
          },
          { status: 404 },
        );
      }
      const session = await service.rotateLinkSession(
        {
          linkId: body.linkId,
          remoteBrokerId: link.remoteBrokerId,
          traceId: crypto.randomUUID(),
        },
        typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined,
      );
      return Response.json({ ok: true, session });
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleTunnelUpgrade(req: Request): Promise<Response> {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const bearerToken = extractBearerToken(req);
    const negotiatedProtocol = getAcceptedTunnelProtocol(
      req.headers.get("sec-websocket-protocol"),
    );
    if (!negotiatedProtocol) {
      return new Response(
        `Expected WebSocket subprotocol: ${DENOCLAW_TUNNEL_PROTOCOL}`,
        { status: 426 },
      );
    }

    const auth = await this.getAuth();

    if (!bearerToken) {
      return Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            recovery:
              "Add Authorization: Bearer <invite-or-session-token> header",
          },
        },
        { status: 401 },
      );
    }

    const inviteResult = await auth.verifyInviteToken(bearerToken);
    const sessionResult = inviteResult.ok
      ? inviteResult
      : await auth.verifySessionToken(bearerToken);
    if (!sessionResult.ok) {
      return Response.json(
        {
          error: {
            code: "AUTH_FAILED",
            recovery: "Reconnect with a valid tunnel invite or session token",
          },
        },
        { status: 401 },
      );
    }

    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: negotiatedProtocol,
      idleTimeout: TUNNEL_IDLE_TIMEOUT_SECONDS,
    });
    const tunnelId = sessionResult.identity;

    const placeholderCaps: TunnelCapabilities = {
      tunnelId,
      type: "local",
      tools: [],
      allowedAgents: [],
    };
    this.tunnels.set(tunnelId, {
      ws: socket,
      capabilities: placeholderCaps,
      registered: false,
    });

    socket.onopen = async () => {
      log.info(`Tunnel connected: ${tunnelId} (${negotiatedProtocol})`);

      try {
        const session = await auth.generateSessionToken(tunnelId);
        socket.send(
          JSON.stringify({
            type: "session_token",
            token: session.token,
            expiresAt: session.expiresAt,
          }),
        );
      } catch (e) {
        log.error(`Failed to generate session token for tunnel ${tunnelId}`, e);
        socket.send(
          JSON.stringify({
            type: "error",
            code: "SESSION_TOKEN_FAILED",
            recovery: "Reconnect",
          }),
        );
        socket.close(1011, "Session token generation failed");
      }
    };

    socket.onmessage = async (e) => {
      try {
        if (typeof e.data !== "string") {
          socket.close(1003, "Tunnel messages must be text JSON");
          return;
        }

        const data = JSON.parse(e.data);
        const entry = this.tunnels.get(tunnelId);
        if (!entry) {
          socket.close(1011, "Tunnel state missing");
          return;
        }

        if (!entry.registered) {
          const registration = assertTunnelRegisterMessage(data);
          const caps: TunnelCapabilities = {
            tunnelId,
            type: registration.tunnelType,
            tools: registration.tools,
            toolPermissions: registration.toolPermissions,
            agents: registration.agents,
            allowedAgents: registration.allowedAgents,
          };
          this.tunnels.set(tunnelId, {
            ws: socket,
            capabilities: caps,
            registered: true,
          });
          if (caps.type === "instance") {
            const service = await this.getFederationService();
            await service.syncCatalog(
              tunnelId,
              mapInstanceTunnelToCatalog(tunnelId, caps),
              {
                remoteBrokerId: tunnelId,
                traceId: crypto.randomUUID(),
              },
            );
          }
          log.info(
            `Tunnel registered: ${tunnelId} (type: ${caps.type}, tools: ${caps.tools}, agents: ${
              caps.agents || []
            }, protocol: ${socket.protocol})`,
          );
          socket.send(JSON.stringify({ type: "registered", tunnelId }));
          return;
        }

        if (
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          data.type === "register"
        ) {
          socket.close(1002, "Tunnel is already registered");
          return;
        }

        // Otherwise = response to a routed request
        await this.handleTunnelMessage(tunnelId, e.data as string);
      } catch (err) {
        log.error(`Tunnel error ${tunnelId}`, err);
        socket.close(1002, "Invalid tunnel control message");
      }
    };

    socket.onclose = () => {
      this.tunnels.delete(tunnelId);
      log.info(`Tunnel disconnected: ${tunnelId}`);
    };

    return response;
  }

  // ── Helpers ─────────────────────────────────────────

  /**
   * Send a broker reply to an agent.
   * Prefer an active WebSocket tunnel; otherwise fall back to the local KV Queue transport.
   */
  private async sendReply(reply: BrokerMessage): Promise<void> {
    const tunnel = this.findTunnelByAgentId(reply.to);
    if (tunnel) {
      this.routeToTunnel(tunnel, reply);
      return;
    }

    const kv = await this.getKv();
    await kv.enqueue(reply);
    log.info(
      `Reponse routee via KV Queue : broker -> ${reply.to} (${reply.type})`,
    );
  }

  private findTunnelByAgentId(agentId: string): WebSocket | null {
    // Check instance tunnels (deployed agents)
    const instanceTunnel = this.findTunnelForAgent(agentId);
    if (instanceTunnel) return instanceTunnel;

    // Check local tunnels (agents connected locally)
    for (const [_, t] of this.tunnels) {
      if (
        t.registered &&
        t.capabilities.type === "local" &&
        t.capabilities.allowedAgents.includes(agentId)
      ) {
        return t.ws;
      }
    }
    return null;
  }

  private async sendTaskResult(
    to: string,
    requestId: string,
    task: Task | null,
  ): Promise<void> {
    const reply: Extract<BrokerMessage, { type: "task_result" }> = {
      id: requestId,
      from: "broker",
      to,
      type: "task_result",
      payload: { task },
      timestamp: new Date().toISOString(),
    };
    await this.sendReply(reply);
  }

  private async sendStructuredError(
    to: string,
    requestId: string,
    error: StructuredError,
  ): Promise<void> {
    const reply: Extract<BrokerMessage, { type: "error" }> = {
      id: requestId,
      from: "broker",
      to,
      type: "error",
      payload: error,
      timestamp: new Date().toISOString(),
    };
    await this.sendReply(reply);
  }

  async stop(): Promise<void> {
    if (this.httpServer) await this.httpServer.shutdown();
    for (const [tunnelId, t] of this.tunnels) {
      try {
        t.ws.close(1001, "Broker shutting down");
      } catch (e) {
        log.warn(`Failed to close tunnel ${tunnelId} cleanly`, e);
      }
    }
    this.tunnels.clear();
    this.taskStore.close();
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
    log.info("Broker stopped");
  }
}
