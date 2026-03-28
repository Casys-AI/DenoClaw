import type {
  BrokerMessage,
  BrokerTaskContinuePayload,
  BrokerTaskQueryPayload,
  BrokerTaskResultPayload,
  BrokerTaskSubmitPayload,
  TunnelCapabilities,
} from "./types.ts";
import type {
  AgentEntry,
  ExecPolicy,
  SandboxPermission,
  StructuredError,
  ToolResult,
} from "../shared/types.ts";
import type { Config } from "../config/types.ts";
import type { BuiltinToolName } from "../agent/tools/types.ts";
import { BUILTIN_TOOL_PERMISSIONS } from "../agent/tools/types.ts";
import { checkExecPolicy } from "../agent/tools/shell.ts";
import { AuthManager } from "./auth.ts";
import { ProviderManager } from "../llm/manager.ts";
import { SandboxManager } from "./sandbox.ts";
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
  sandbox?: SandboxManager;
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

const DEFAULT_EXEC_POLICY: ExecPolicy = {
  security: "allowlist",
  allowedCommands: [],
  ask: "on-miss",
  askFallback: "deny",
};

export class BrokerServer {
  private config: Config;
  private auth!: AuthManager;
  private providers: ProviderManager;
  private sandbox: SandboxManager;
  private metrics: MetricsCollector;
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;
  private taskStore: TaskStore;
  private tunnels = new Map<
    string,
    { ws: WebSocket; capabilities: TunnelCapabilities; sessionToken?: string }
  >();
  private httpServer?: Deno.HttpServer;

  constructor(config: Config, deps?: BrokerServerDeps) {
    this.config = config;
    this.providers = deps?.providers ?? new ProviderManager(config.providers);
    this.sandbox = deps?.sandbox ?? new SandboxManager();
    this.metrics = deps?.metrics ?? new MetricsCollector();
    this.kv = deps?.kv ?? null;
    this.ownsKv = !deps?.kv;
    this.taskStore = deps?.taskStore ?? new TaskStore(deps?.kv);
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

  async start(port = 3000): Promise<void> {
    // Warning si pas de token configuré (ADR-003)
    if (!Deno.env.get("DENOCLAW_API_TOKEN")) {
      log.warn(
        "DENOCLAW_API_TOKEN not set — broker running in unauthenticated mode. Do not use in production.",
      );
    }

    const kv = await this.getKv();

    // Initialiser AuthManager avec le KV partagé (une seule connexion)
    this.auth = new AuthManager(kv);

    // Listen for agent requests via KV Queue
    kv.listenQueue(async (raw: unknown) => {
      const msg = raw as BrokerMessage;
      if (msg.to !== "broker") return;
      await this.handleMessage(msg);
    });

    // HTTP + WebSocket server
    this.httpServer = Deno.serve({ port }, (req) => this.handleHttp(req));

    log.info(`Broker démarré sur port ${port}`);
  }

  private async handleMessage(msg: BrokerMessage): Promise<void> {
    log.info(`Broker: ${msg.type} de ${msg.from}`);

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
        default:
          log.warn(`Type de message inconnu : ${msg.type}`);
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
    const kv = await this.getKv();

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
    await this.metrics.recordLLMCall(msg.from, provider, {
      prompt: response.usage?.promptTokens || 0,
      completion: response.usage?.completionTokens || 0,
    }, latency);

    const reply: BrokerMessage = {
      id: msg.id,
      from: "broker",
      to: msg.from,
      type: "llm_response",
      payload: response,
      timestamp: new Date().toISOString(),
    };

    await kv.enqueue(reply);
  }

  // ── Tool routing (ADR-005: permissions par intersection) ─

  /** AX-8: permission check extracted as composable primitive */
  private async checkToolPermissions(
    agentId: string,
    tool: string,
  ): Promise<
    {
      granted: SandboxPermission[];
      denied: SandboxPermission[];
      agentConfig: Deno.KvEntryMaybe<AgentEntry>;
    }
  > {
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
          JSON.stringify(denied)
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

    // 4. Execute in Sandbox (éphémère)
    try {
      const code = this.buildSandboxCode(req.tool, req.args);

      // networkAllow : agent-specific > defaults > [] (ADR-005)
      const agentNetwork = agentConfig.value?.sandbox?.networkAllow;
      const defaultNetwork = this.config.agents?.defaults?.sandbox
        ?.networkAllow;
      const networkAllow = agentNetwork || defaultNetwork || [];

      const maxDuration = agentConfig.value?.sandbox?.maxDurationSec ||
        this.config.agents?.defaults?.sandbox?.maxDurationSec || 30;

      log.info(
        `Sandbox: ${req.tool} avec permissions ${
          JSON.stringify(granted)
        }, network: ${JSON.stringify(networkAllow)}`,
      );

      const result = await this.sandbox.run(code, {
        memoryMb: 256,
        timeoutSec: maxDuration,
        networkAllow,
      });

      const toolSuccess = result.exitCode === 0;
      await this.metrics.recordToolCall(
        msg.from,
        req.tool,
        toolSuccess,
        performance.now() - toolStart,
      );

      await this.replyToolResult(msg.from, msg.id, {
        success: toolSuccess,
        output: result.stdout,
        error: !toolSuccess
          ? {
            code: "SANDBOX_EXEC_FAILED",
            context: { stderr: result.stderr, exitCode: result.exitCode },
            recovery: "Check tool arguments",
          }
          : undefined,
      });
    } catch (e) {
      await this.sendStructuredError(msg.from, msg.id, {
        code: "SANDBOX_CREATE_FAILED",
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
    const check = checkExecPolicy(command, policy);
    if (check.allowed) return null;

    if (
      req.taskId &&
      check.reason !== "denied" &&
      (policy.ask === "always" || policy.ask === "on-miss") &&
      await this.consumeApprovedTaskResume(req.taskId, command)
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
          recovery: "Resume the canonical task with approval metadata to continue",
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
        recovery:
          `Add '${check.binary ?? command}' to execPolicy.allowedCommands or use ask: 'on-miss'`,
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
    const result = await kv.atomic().check(entry).set(
      ["a2a_tasks", taskId],
      nextTask,
    ).commit();
    return result.ok;
  }

  private async replyToolResult(
    to: string,
    replyToId: string,
    payload: ToolResult,
  ): Promise<void> {
    const kv = await this.getKv();
    const reply: BrokerMessage = {
      id: replyToId,
      from: "broker",
      to,
      type: "tool_response",
      payload,
      timestamp: new Date().toISOString(),
    };
    await kv.enqueue(reply);
  }

  /**
   * Résout les permissions d'un outil (ADR-005).
   * Built-in map = source de vérité pour les outils connus.
   * Tunnel-advertised = pour les outils custom pas dans la map.
   */
  private isBuiltinTool(tool: string): tool is BuiltinToolName {
    return tool in BUILTIN_TOOL_PERMISSIONS;
  }

  private resolveToolPermissions(tool: string): SandboxPermission[] {
    // 1. Built-in map (source de vérité, non-overridable par un tunnel)
    if (this.isBuiltinTool(tool)) return [...BUILTIN_TOOL_PERMISSIONS[tool]];

    // 2. Tunnel-advertised (outils custom uniquement)
    for (const [_, t] of this.tunnels) {
      if (t.capabilities.toolPermissions?.[tool]) {
        return [...t.capabilities.toolPermissions[tool]];
      }
    }

    // 3. Deny by default — outil inconnu = aucune permission
    return [];
  }

  /**
   * Build Deno code to execute a tool inside a Sandbox.
   */
  private buildSandboxCode(
    tool: string,
    args: Record<string, unknown>,
  ): string {
    switch (tool) {
      case "shell":
        return `
const cmd = new Deno.Command("sh", {
  args: ["-c", ${JSON.stringify(args.command || "")}],
  stdout: "piped", stderr: "piped",
});
const { stdout, stderr } = await cmd.output();
console.log(new TextDecoder().decode(stdout));
if (stderr.length > 0) console.error(new TextDecoder().decode(stderr));
`;
      case "read_file":
        return `console.log(await Deno.readTextFile(${
          JSON.stringify(args.path || "")
        }));`;
      case "write_file":
        return `await Deno.writeTextFile(${JSON.stringify(args.path || "")}, ${
          JSON.stringify(args.content || "")
        });
console.log("Written: " + ${JSON.stringify(String(args.path || ""))});`;
      case "web_fetch": {
        const method = (args.method as string) || "GET";
        return `const r = await fetch(${
          JSON.stringify(args.url || "")
        }, { method: ${JSON.stringify(method)} });
console.log("HTTP " + r.status);
console.log(await r.text());`;
      }
      default:
        return `console.error("Unknown tool: " + ${
          JSON.stringify(tool)
        }); Deno.exit(1);`;
    }
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

    const task = await this.taskStore.create(
      payload.taskId,
      payload.message,
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

    const resume = getResumePayloadMetadata({ metadata: payload.metadata });
    if (resume?.approved === false) {
      const rejected = transitionTask(existing, "REJECTED", {
        message: payload.message,
      });
      rejected.history = [...existing.history, payload.message];
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
      payload,
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
      ? metadata as BrokerTaskMetadata
      : {};
  }

  private getPendingResumes(brokerMetadata: BrokerTaskMetadata): PendingResumes {
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
    message: Extract<BrokerMessage, {
      type: "task_submit" | "task_continue"
    }>,
  ): Promise<void> {
    const kv = await this.getKv();

    await this.metrics.recordAgentMessage(message.from, targetAgentId);

    const remoteTunnel = this.findTunnelForAgent(targetAgentId);
    if (remoteTunnel) {
      remoteTunnel.send(JSON.stringify(message));
      log.info(
        `A2A routé via tunnel instance : ${message.from} → ${targetAgentId} (${message.type})`,
      );
      return;
    }

    await kv.enqueue(message);
    log.info(`A2A routé local : ${message.from} → ${targetAgentId} (${message.type})`);
  }

  // ── Tunnel management ───────────────────────────────

  private findTunnelForProvider(_model: string): WebSocket | null {
    // CLI providers now run on the agent's VPS, not via tunnel.
    // Tunnels are for tools and instance-to-instance routing.
    return null;
  }

  private findTunnelForTool(tool: string): WebSocket | null {
    for (const [_, t] of this.tunnels) {
      if (t.capabilities.tools.includes(tool)) {
        return t.ws;
      }
    }
    return null;
  }

  private findTunnelForAgent(agentId: string): WebSocket | null {
    for (const [_, t] of this.tunnels) {
      if (
        t.capabilities.type === "instance" &&
        t.capabilities.agents?.includes(agentId)
      ) {
        return t.ws;
      }
    }
    return null;
  }

  private routeToTunnel(ws: WebSocket, msg: BrokerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new DenoClawError("TUNNEL_NOT_OPEN", {
        readyState: ws.readyState,
        msgId: msg.id,
      }, "Tunnel disconnected. Reconnect and retry.");
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
      const kv = await this.getKv();
      await kv.enqueue(msg);
    } catch (e) {
      log.error(`Failed to enqueue tunnel message from ${tunnelId}`, e);
    }
  }

  // ── HTTP + WebSocket (ADR-003: auth intégré) ───────

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

    // Root — public, pas d'auth
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

    // Tunnel WebSocket — auth par invite token (ADR-003)
    if (url.pathname === "/tunnel") {
      return await this.handleTunnelUpgrade(req);
    }

    // Invite token generation — admin endpoint
    if (req.method === "POST" && url.pathname === "/auth/invite") {
      const authResult = await this.auth.checkRequest(req);
      if (!authResult.ok) {
        return Response.json({
          error: { code: authResult.code, recovery: authResult.recovery },
        }, { status: 401 });
      }
      const body = await req.json().catch(() => ({})) as { tunnelId?: string };
      const invite = await this.auth.generateInviteToken(body.tunnelId);
      return Response.json({
        token: invite.token,
        expiresAt: invite.expiresAt,
      });
    }

    // Tous les autres endpoints nécessitent auth (ADR-003)
    const authResult = await this.auth.checkRequest(req);
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
        .filter((t) => t.capabilities.agents)
        .flatMap((t) => t.capabilities.agents ?? []);
      return createSSEResponse(kv, agentIds);
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleTunnelUpgrade(req: Request): Promise<Response> {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(req.url);
    const inviteTokenParam = url.searchParams.get("token");

    // Vérifier le token d'invitation (ADR-003)
    if (inviteTokenParam) {
      const inviteResult = await this.auth.verifyInviteToken(inviteTokenParam);
      if (!inviteResult.ok) {
        return Response.json(
          {
            error: { code: inviteResult.code, recovery: inviteResult.recovery },
          },
          { status: 401 },
        );
      }
    } else {
      const authResult = await this.auth.checkRequest(req);
      if (!authResult.ok) {
        return Response.json(
          { error: { code: authResult.code, recovery: authResult.recovery } },
          { status: 401 },
        );
      }
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const tunnelId = url.searchParams.get("id") || generateId();

    // Pré-créer l'entrée tunnel pour que onopen puisse y attacher le session token
    const placeholderCaps: TunnelCapabilities = {
      tunnelId,
      type: "local",
      tools: [],
      allowedAgents: [],
    };
    this.tunnels.set(tunnelId, { ws: socket, capabilities: placeholderCaps });

    socket.onopen = async () => {
      log.info(`Tunnel connecté : ${tunnelId}`);

      try {
        // Émettre un session token éphémère pour ce tunnel (ADR-003)
        const session = await this.auth.generateSessionToken(tunnelId);
        // Stocker le token pour révocation à la déconnexion
        const entry = this.tunnels.get(tunnelId);
        if (entry) {
          this.tunnels.set(tunnelId, { ...entry, sessionToken: session.token });
        }
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
        const data = JSON.parse(e.data as string);

        // First message = capabilities registration (met à jour l'entrée placeholder)
        if (data.type === "register") {
          const caps: TunnelCapabilities = {
            tunnelId,
            type: data.tunnelType || "local",
            tools: data.tools || [],
            toolPermissions: data.toolPermissions,
            supportsAuth: data.supportsAuth || false,
            agents: data.agents || [],
            allowedAgents: data.allowedAgents || [],
          };
          const existing = this.tunnels.get(tunnelId);
          this.tunnels.set(tunnelId, {
            ws: socket,
            capabilities: caps,
            sessionToken: existing?.sessionToken,
          });
          log.info(
            `Tunnel enregistré : ${tunnelId} (type: ${caps.type}, tools: ${caps.tools}, agents: ${
              caps.agents || []
            })`,
          );
          socket.send(JSON.stringify({ type: "registered", tunnelId }));
          return;
        }

        // Otherwise = response to a routed request
        await this.handleTunnelMessage(tunnelId, e.data as string);
      } catch (err) {
        log.error(`Erreur tunnel ${tunnelId}`, err);
      }
    };

    socket.onclose = async () => {
      // Révoquer le session token (ADR-003)
      const tunnel = this.tunnels.get(tunnelId);
      if (tunnel?.sessionToken) {
        await this.auth.revokeSessionToken(tunnel.sessionToken);
      }
      this.tunnels.delete(tunnelId);
      log.info(`Tunnel déconnecté : ${tunnelId}`);
    };

    return response;
  }

  // ── Helpers ─────────────────────────────────────────

  private async sendTaskResult(
    to: string,
    requestId: string,
    task: Task | null,
  ): Promise<void> {
    const kv = await this.getKv();
    const reply: Extract<BrokerMessage, { type: "task_result" }> = {
      id: requestId,
      from: "broker",
      to,
      type: "task_result",
      payload: { task },
      timestamp: new Date().toISOString(),
    };
    await kv.enqueue(reply);
  }

  private async sendStructuredError(
    to: string,
    requestId: string,
    error: StructuredError,
  ): Promise<void> {
    const kv = await this.getKv();
    const reply: Extract<BrokerMessage, { type: "error" }> = {
      id: requestId,
      from: "broker",
      to,
      type: "error",
      payload: error,
      timestamp: new Date().toISOString(),
    };
    await kv.enqueue(reply);
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
    log.info("Broker arrêté");
  }
}
