import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { BrokerServer } from "./broker.ts";
import { AuthManager } from "./auth.ts";
import {
  DENOCLAW_TUNNEL_PROTOCOL,
  getAcceptedTunnelProtocol,
  WS_BUFFERED_AMOUNT_HIGH_WATERMARK,
} from "./tunnel_protocol.ts";
import {
  createAwaitedInputMetadata,
  createResumePayloadMetadata,
} from "../messaging/a2a/input_metadata.ts";
import type { BrokerMessage } from "./types.ts";
import type { A2AMessage, Task } from "../messaging/a2a/types.ts";

function createConfig() {
  return {
    providers: {},
    agents: {
      defaults: { model: "test/model", temperature: 0.2, maxTokens: 256 },
    },
    tools: {},
    channels: {},
  };
}

function createMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

async function seedPeerPolicy(
  kv: Deno.Kv,
  fromAgentId: string,
  targetAgentId: string,
): Promise<void> {
  await kv.set(["agents", fromAgentId, "config"], {
    peers: [targetAgentId],
  });
  await kv.set(["agents", targetAgentId, "config"], {
    acceptFrom: [fromAgentId],
  });
}

function waitForQueuedMessage(
  kv: Deno.Kv,
  predicate: (message: BrokerMessage) => boolean,
): Promise<BrokerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for queued message"));
    }, 5_000);

    kv.listenQueue((raw: unknown) => {
      const message = raw as BrokerMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

Deno.test("BrokerServer.submitAgentTask persists canonical task and forwards canonical task submit", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    const forwardedPromise = waitForQueuedMessage(
      kv,
      (message) =>
        message.type === "task_submit" && message.to === "agent-beta",
    );

    const task = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-1",
      contextId: "ctx-1",
      taskMessage: createMessage("Summarise this"),
      metadata: { source: "test" },
    });

    assertEquals(task.id, "task-1");
    assertEquals(task.contextId, "ctx-1");
    assertEquals(task.status.state, "SUBMITTED");
    assertEquals(task.metadata?.broker, {
      submittedBy: "agent-alpha",
      targetAgent: "agent-beta",
      request: { source: "test" },
    });

    const persisted = await broker.getTask({ taskId: "task-1" });
    assertExists(persisted);
    assertEquals(persisted?.metadata?.broker, task.metadata?.broker);

    const forwarded = await forwardedPromise as Extract<
      BrokerMessage,
      { type: "task_submit" }
    >;
    assertEquals(forwarded.type, "task_submit");
    assertEquals(forwarded.payload.taskId, "task-1");
    assertEquals(forwarded.payload.contextId, "ctx-1");
    assertEquals(forwarded.payload.targetAgent, "agent-beta");
    assertEquals(forwarded.payload.taskMessage?.parts[0], {
      kind: "text",
      text: "Summarise this",
    });
    assertEquals(forwarded.payload.metadata, { source: "test" });

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.recordTaskResult persists canonical execution progress and completion", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-runtime",
      contextId: "ctx-runtime",
      taskMessage: createMessage("Handle this"),
    });

    const working = await broker.recordTaskResult("agent-beta", {
      task: {
        ...submitted,
        status: {
          state: "WORKING",
          timestamp: new Date().toISOString(),
        },
      },
    });
    assertExists(working);
    assertEquals(working?.status.state, "WORKING");

    const completed = await broker.recordTaskResult("agent-beta", {
      task: {
        ...submitted,
        status: {
          state: "COMPLETED",
          timestamp: new Date().toISOString(),
          message: {
            messageId: crypto.randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: "Done" }],
          },
        },
        artifacts: [
          {
            artifactId: "task-runtime:result",
            name: "result",
            parts: [{ kind: "text", text: "Done" }],
          },
        ],
      },
    });

    assertExists(completed);
    assertEquals(completed?.status.state, "COMPLETED");
    assertEquals(completed?.artifacts[0]?.parts[0], {
      kind: "text",
      text: "Done",
    });
    assertEquals(completed?.metadata?.broker, {
      submittedBy: "agent-alpha",
      targetAgent: "agent-beta",
    });

    const persisted = await broker.getTask({ taskId: submitted.id });
    assertEquals(persisted?.status.state, "COMPLETED");

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.recordTaskResult rejects updates from non-target agents", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-forbidden",
      taskMessage: createMessage("Handle this"),
    });

    await assertRejects(
      () =>
        broker.recordTaskResult("agent-gamma", {
          task: {
            ...submitted,
            status: {
              state: "WORKING",
              timestamp: new Date().toISOString(),
            },
          },
        }),
      Error,
      'Only "agent-beta" can report the result',
    );

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.continueAgentTask forwards canonical continuation without mutating runtime state locally", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-continue",
      contextId: "ctx-continue",
      message: createMessage("Need approval"),
    });

    const paused: Task = {
      ...submitted,
      status: {
        state: "INPUT_REQUIRED",
        timestamp: new Date().toISOString(),
        metadata: {
          awaitedInput: {
            kind: "approval",
            command: "git status",
            binary: "git",
            prompt: "approve?",
          },
        },
      },
    };
    await kv.set(["a2a_tasks", paused.id], paused);

    const forwardedPromise = waitForQueuedMessage(
      kv,
      (message) =>
        message.type === "task_continue" && message.to === "agent-beta",
    );

    const resumed = await broker.continueAgentTask("agent-alpha", {
      taskId: paused.id,
      continuationMessage: createMessage("Approved, continue"),
      metadata: createResumePayloadMetadata({
        kind: "approval",
        approved: true,
      }),
    });

    assertExists(resumed);
    assertEquals(resumed?.status.state, "INPUT_REQUIRED");

    const forwarded = await forwardedPromise as Extract<
      BrokerMessage,
      { type: "task_continue" }
    >;
    assertEquals(forwarded.payload.taskId, paused.id);
    assertEquals(forwarded.payload.continuationMessage?.parts[0], {
      kind: "text",
      text: "Approved, continue",
    });
    assertEquals(forwarded.payload.metadata, {
      resume: { kind: "approval", approved: true },
    });

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.continueAgentTask classifies explicit refusal as REJECTED", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-reject",
      taskMessage: createMessage("Dangerous action"),
    });

    await kv.set(["a2a_tasks", submitted.id], {
      ...submitted,
      status: {
        state: "INPUT_REQUIRED",
        timestamp: new Date().toISOString(),
      },
    });

    const rejected = await broker.continueAgentTask("agent-alpha", {
      taskId: submitted.id,
      continuationMessage: createMessage("No"),
      metadata: createResumePayloadMetadata({
        kind: "approval",
        approved: false,
      }),
    });

    assertExists(rejected);
    assertEquals(rejected?.status.state, "REJECTED");
    assertEquals(rejected?.history.at(-1)?.parts[0], {
      kind: "text",
      text: "No",
    });

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.submitAgentTask enforces peer policy", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await kv.set(["agents", "agent-alpha", "config"], { peers: [] });
    await kv.set(["agents", "agent-beta", "config"], {
      acceptFrom: ["agent-alpha"],
    });

    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    await assertRejects(
      () =>
        broker.submitAgentTask("agent-alpha", {
          targetAgent: "agent-beta",
          taskId: "blocked-task",
          message: createMessage("Blocked"),
        }),
      Error,
      'Add "agent-beta" to agent-alpha.peers',
    );

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer returns EXEC_APPROVAL_REQUIRED for broker-backed shell tasks", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await kv.set(["agents", "agent-alpha", "config"], {
      sandbox: {
        allowedPermissions: ["run"],
        execPolicy: {
          security: "allowlist",
          allowedCommands: ["git"],
          ask: "always",
        },
      },
    });

    let sandboxCalls = 0;
    const broker = new BrokerServer(createConfig(), {
      kv,
      toolExecution: {
        executeTool: async () => {
          sandboxCalls++;
          return { success: true, output: "" };
        },
        resolveToolPermissions: () => ["run"],
        checkExecPolicy: () => ({ allowed: false, reason: "always-ask", binary: "git" }),
        getToolPermissions: () => ({}),
      },
      // deno-lint-ignore no-explicit-any
      metrics: { recordToolCall: async () => {} } as any,
    });

    const replyPromise = waitForQueuedMessage(
      kv,
      (message) =>
        message.type === "tool_response" && message.to === "agent-alpha",
    );

    await (broker as unknown as {
      handleToolRequest(
        msg: Extract<BrokerMessage, { type: "tool_request" }>,
      ): Promise<void>;
    }).handleToolRequest({
      id: "tool-req-1",
      from: "agent-alpha",
      to: "broker",
      type: "tool_request",
      timestamp: new Date().toISOString(),
      payload: {
        tool: "shell",
        args: { command: "git status", dry_run: false },
        taskId: "task-approval",
      },
    });

    const reply = await replyPromise as Extract<
      BrokerMessage,
      { type: "tool_response" }
    >;
    assertEquals(reply.payload.error?.code, "EXEC_APPROVAL_REQUIRED");
    assertEquals(reply.payload.error?.context, {
      taskId: "task-approval",
      command: "git status",
      binary: "git",
      reason: "always-ask",
    });
    assertEquals(sandboxCalls, 0);

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer consumes one approved continuation to allow the next broker-backed shell execution", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    await kv.set(["agents", "agent-beta", "config"], {
      acceptFrom: ["agent-alpha"],
      sandbox: {
        allowedPermissions: ["run"],
        execPolicy: {
          security: "allowlist",
          allowedCommands: ["git"],
          ask: "always",
        },
      },
    });

    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-resume-grant",
      taskMessage: createMessage("Run git status"),
    });

    await kv.set(["a2a_tasks", submitted.id], {
      ...submitted,
      status: {
        state: "INPUT_REQUIRED",
        timestamp: new Date().toISOString(),
        metadata: createAwaitedInputMetadata({
          kind: "approval",
          command: "git status",
          binary: "git",
        }),
      },
    });

    await broker.continueAgentTask("agent-alpha", {
      taskId: submitted.id,
      continuationMessage: createMessage("Approved"),
      metadata: createResumePayloadMetadata({
        kind: "approval",
        approved: true,
      }),
    });

    const firstCheck = await (broker as unknown as {
      resolveBrokerToolApprovalRequirement(
        agentId: string,
        req: { tool: string; args: Record<string, unknown>; taskId?: string },
        agentPolicy?: unknown,
        defaultPolicy?: unknown,
      ): Promise<unknown>;
    }).resolveBrokerToolApprovalRequirement(
      "agent-beta",
      {
        tool: "shell",
        args: { command: "git status", dry_run: false },
        taskId: submitted.id,
      },
      {
        security: "allowlist",
        allowedCommands: ["git"],
        ask: "always",
      },
      undefined,
    );
    assertEquals(firstCheck, null);

    const secondCheck = await (broker as unknown as {
      resolveBrokerToolApprovalRequirement(
        agentId: string,
        req: { tool: string; args: Record<string, unknown>; taskId?: string },
        agentPolicy?: unknown,
        defaultPolicy?: unknown,
      ): Promise<{ error?: { code?: string } } | null>;
    }).resolveBrokerToolApprovalRequirement(
      "agent-beta",
      {
        tool: "shell",
        args: { command: "git status", dry_run: false },
        taskId: submitted.id,
      },
      {
        security: "allowlist",
        allowedCommands: ["git"],
        ask: "always",
      },
      undefined,
    );
    assertEquals(secondCheck?.error?.code, "EXEC_APPROVAL_REQUIRED");

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer rejects grant consumption when command does not match", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    await kv.set(["agents", "agent-beta", "config"], {
      acceptFrom: ["agent-alpha"],
      sandbox: {
        allowedPermissions: ["run"],
        execPolicy: {
          security: "allowlist",
          allowedCommands: ["git", "npm"],
          ask: "always",
        },
      },
    });

    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-mismatch",
      taskMessage: createMessage("Run git status"),
    });

    // Pause with approval for "git status"
    await kv.set(["a2a_tasks", submitted.id], {
      ...submitted,
      status: {
        state: "INPUT_REQUIRED",
        timestamp: new Date().toISOString(),
        metadata: createAwaitedInputMetadata({
          kind: "approval",
          command: "git status",
          binary: "git",
        }),
      },
    });

    // Approve "git status"
    await broker.continueAgentTask("agent-alpha", {
      taskId: submitted.id,
      continuationMessage: createMessage("Approved"),
      metadata: createResumePayloadMetadata({
        kind: "approval",
        approved: true,
      }),
    });

    // Try to consume with a DIFFERENT command — must be rejected
    const mismatchCheck = await (broker as unknown as {
      resolveBrokerToolApprovalRequirement(
        agentId: string,
        req: { tool: string; args: Record<string, unknown>; taskId?: string },
        agentPolicy?: unknown,
        defaultPolicy?: unknown,
      ): Promise<{ error?: { code?: string } } | null>;
    }).resolveBrokerToolApprovalRequirement(
      "agent-beta",
      {
        tool: "shell",
        args: { command: "npm install", dry_run: false },
        taskId: submitted.id,
      },
      {
        security: "allowlist",
        allowedCommands: ["git", "npm"],
        ask: "always",
      },
      undefined,
    );
    assertEquals(mismatchCheck?.error?.code, "EXEC_APPROVAL_REQUIRED");

    // Original command still works
    const matchCheck = await (broker as unknown as {
      resolveBrokerToolApprovalRequirement(
        agentId: string,
        req: { tool: string; args: Record<string, unknown>; taskId?: string },
        agentPolicy?: unknown,
        defaultPolicy?: unknown,
      ): Promise<unknown>;
    }).resolveBrokerToolApprovalRequirement(
      "agent-beta",
      {
        tool: "shell",
        args: { command: "git status", dry_run: false },
        taskId: submitted.id,
      },
      {
        security: "allowlist",
        allowedCommands: ["git", "npm"],
        ask: "always",
      },
      undefined,
    );
    assertEquals(matchCheck, null);

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("Broker tunnel protocol negotiation prefers the canonical subprotocol", () => {
  assertEquals(
    getAcceptedTunnelProtocol(
      `${DENOCLAW_TUNNEL_PROTOCOL}, legacy-protocol`,
    ),
    DENOCLAW_TUNNEL_PROTOCOL,
  );
  assertEquals(getAcceptedTunnelProtocol("legacy-protocol"), undefined);
  assertEquals(getAcceptedTunnelProtocol(null), undefined);
});

Deno.test("BrokerServer rejects tunnel upgrades without the canonical subprotocol", async () => {
  const broker = new BrokerServer(createConfig(), {
    // deno-lint-ignore no-explicit-any
    metrics: { recordAgentMessage: async () => {} } as any,
  });

  try {
    const res = await (broker as unknown as {
      handleTunnelUpgrade(req: Request): Promise<Response>;
    }).handleTunnelUpgrade(
      new Request("http://localhost/tunnel", {
        headers: {
          upgrade: "websocket",
        },
      }),
    );

    assertEquals(res.status, 426);
    assertEquals(
      await res.text(),
      `Expected WebSocket subprotocol: ${DENOCLAW_TUNNEL_PROTOCOL}`,
    );
  } finally {
    await broker.stop();
  }
});

Deno.test("BrokerServer rejects tunnel upgrades without Authorization bearer auth", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  const broker = new BrokerServer(createConfig(), {
    kv,
    // deno-lint-ignore no-explicit-any
    metrics: { recordAgentMessage: async () => {} } as any,
  });
  (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);

  try {
    const res = await (broker as unknown as {
      handleTunnelUpgrade(req: Request): Promise<Response>;
    }).handleTunnelUpgrade(
      new Request("http://localhost/tunnel", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": DENOCLAW_TUNNEL_PROTOCOL,
        },
      }),
    );

    assertEquals(res.status, 401);
    assertEquals(await res.json(), {
      error: {
        code: "UNAUTHORIZED",
        recovery: "Add Authorization: Bearer <invite-or-session-token> header",
      },
    });
  } finally {
    await broker.stop();
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer tunnel auth does not fall back to static API tokens", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  const broker = new BrokerServer(createConfig(), {
    kv,
    // deno-lint-ignore no-explicit-any
    metrics: { recordAgentMessage: async () => {} } as any,
  });
  (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
  const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
  Deno.env.set("DENOCLAW_API_TOKEN", "static-token");

  try {
    const res = await (broker as unknown as {
      handleTunnelUpgrade(req: Request): Promise<Response>;
    }).handleTunnelUpgrade(
      new Request("http://localhost/tunnel", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": DENOCLAW_TUNNEL_PROTOCOL,
          authorization: "Bearer static-token",
        },
      }),
    );

    assertEquals(res.status, 401);
    assertEquals(await res.json(), {
      error: {
        code: "AUTH_FAILED",
        recovery: "Reconnect with a valid tunnel invite or session token",
      },
    });
  } finally {
    if (previousStaticToken === undefined) {
      Deno.env.delete("DENOCLAW_API_TOKEN");
    } else {
      Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
    }
    await broker.stop();
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer routeToTunnel rejects saturated tunnels", async () => {
  const broker = new BrokerServer(createConfig(), {
    // deno-lint-ignore no-explicit-any
    metrics: { recordAgentMessage: async () => {} } as any,
  });

  try {
    const saturatedSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: WS_BUFFERED_AMOUNT_HIGH_WATERMARK + 1,
      send: () => {
        throw new Error("send should not be called for saturated tunnel");
      },
    } as unknown as WebSocket;

    assertThrows(
      () =>
        (broker as unknown as {
          routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
        }).routeToTunnel(saturatedSocket, {
          id: "msg-backpressure",
          from: "broker",
          to: "agent-beta",
          type: "task_result",
          payload: { task: null },
          timestamp: new Date().toISOString(),
        }),
      Error,
      "Tunnel is saturated",
    );
  } finally {
    await broker.stop();
  }
});
