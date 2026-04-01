/**
 * Gateway E2E tests — full HTTP pipeline: Gateway + WorkerPool + real LLM (Ollama Cloud).
 *
 * Sends requests to POST /chat and verifies agent behaviors end-to-end.
 * Requires OLLAMA_API_KEY in .env.
 * Run: deno test tests/gateway_e2e_test.ts --unstable-kv --unstable-cron --allow-all --env
 */
import "@std/dotenv/load";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { getConfigOrDefault } from "../src/config/loader.ts";
import type { Config } from "../src/config/types.ts";
import { WorkerPool } from "../src/agent/worker_pool.ts";
import { WorkspaceLoader } from "../src/agent/workspace.ts";
import { TaskStore } from "../src/messaging/a2a/tasks.ts";
import { Gateway } from "../src/orchestration/gateway/server.ts";
import { MessageBus } from "../src/messaging/bus.ts";
import { SessionManager } from "../src/messaging/session.ts";
import { ChannelManager } from "../src/messaging/channels/manager.ts";
import {
  InProcessBrokerChannelIngressClient,
  LocalChannelIngressRuntime,
} from "../src/orchestration/channel_ingress/mod.ts";
import { BrokerCronManager } from "../src/orchestration/broker/cron_manager.ts";
import { executeCronToolRequest } from "../src/orchestration/broker/cron_tool_actions.ts";

const TEST_TIMEOUT_MS = 60_000;
const E2E_MODEL = "ollama/nemotron-3-super";
const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function canReachOllamaProvider(): Promise<boolean> {
  const apiKey = Deno.env.get("OLLAMA_API_KEY");
  if (!apiKey) return false;
  try {
    const config = await getConfigOrDefault();
    const apiBase = config.providers.ollama?.apiBase ??
      "https://api.ollama.com";
    await fetch(`${apiBase}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

const OLLAMA_E2E_ENABLED = await canReachOllamaProvider();
const gatewayTestOpts = {
  ...testOpts,
  ...(OLLAMA_E2E_ENABLED ? {} : { ignore: true }),
};

// ── Helpers ─────────────────────────────────────────────

async function withTempAgentsDir(
  fn: (tmpDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "denoclaw_gw_e2e_" });
  const tmpDir = `${rootDir}/agents`;
  const tmpHomeDir = `${rootDir}/home`;
  await Deno.mkdir(tmpDir, { recursive: true });
  await Deno.mkdir(tmpHomeDir, { recursive: true });
  const prevAgentsDir = Deno.env.get("DENOCLAW_AGENTS_DIR");
  const prevHomeDir = Deno.env.get("DENOCLAW_HOME_DIR");
  const prevToken = Deno.env.get("DENOCLAW_API_TOKEN");
  Deno.env.set("DENOCLAW_AGENTS_DIR", tmpDir);
  Deno.env.set("DENOCLAW_HOME_DIR", tmpHomeDir);
  Deno.env.delete("DENOCLAW_API_TOKEN");
  try {
    await fn(tmpDir);
  } finally {
    if (prevAgentsDir) Deno.env.set("DENOCLAW_AGENTS_DIR", prevAgentsDir);
    else Deno.env.delete("DENOCLAW_AGENTS_DIR");
    if (prevHomeDir) Deno.env.set("DENOCLAW_HOME_DIR", prevHomeDir);
    else Deno.env.delete("DENOCLAW_HOME_DIR");
    if (prevToken) Deno.env.set("DENOCLAW_API_TOKEN", prevToken);
    else Deno.env.delete("DENOCLAW_API_TOKEN");
    try {
      await Deno.remove(rootDir, { recursive: true });
    } catch { /* ignore */ }
  }
}

async function createAgent(
  tmpDir: string,
  agentId: string,
  opts: {
    soul?: string;
    permissions?: string[];
    peers?: string[];
    acceptFrom?: string[];
  } = {},
): Promise<void> {
  const agentDir = `${tmpDir}/${agentId}`;
  await Deno.mkdir(`${agentDir}/skills`, { recursive: true });
  await Deno.mkdir(`${agentDir}/memories`, { recursive: true });
  await Deno.writeTextFile(
    `${agentDir}/agent.json`,
    JSON.stringify({
      description: `E2E test agent: ${agentId}`,
      sandbox: {
        allowedPermissions: opts.permissions ?? ["run", "read", "write", "net"],
      },
      ...(opts.peers ? { peers: opts.peers } : {}),
      ...(opts.acceptFrom ? { acceptFrom: opts.acceptFrom } : {}),
    }),
  );
  if (opts.soul) {
    await Deno.writeTextFile(`${agentDir}/soul.md`, opts.soul);
  }
}

interface GatewayTestHarness {
  baseUrl: string;
  pool: WorkerPool;
  gateway: Gateway;
  kv: Deno.Kv;
  tmpDir: string;
  chat: (
    agentId: string,
    message: string,
    sessionId?: string,
  ) => Promise<{
    sessionId: string;
    taskId: string;
    task: { id: string; status: { state: string } };
    response: string;
  }>;
  stop: () => Promise<void>;
}

async function startGatewayHarness(
  tmpDir: string,
  agentIds: string[],
): Promise<GatewayTestHarness> {
  const baseConfig = await getConfigOrDefault();
  const config: Config = {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: { ...baseConfig.agents.defaults, model: E2E_MODEL },
    },
    gateway: { port: 0 },
    channels: {},
  };

  const registry = await WorkspaceLoader.buildRegistry();
  config.agents = {
    ...config.agents,
    registry: { ...config.agents.registry, ...registry },
  };

  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  const pool = new WorkerPool(config);
  pool.setSharedKv(kv);

  const cronKvPath = await Deno.makeTempFile({ suffix: ".db" });
  const cronKv = await Deno.openKv(cronKvPath);
  const cronManager = new BrokerCronManager(cronKv, {
    registerDenoCron: false,
  });
  pool.setCronHandler(async (agentId, request) =>
    await executeCronToolRequest(
      cronManager,
      agentId,
      request.tool,
      request.args,
    )
  );

  await pool.start(agentIds);

  const taskStore = new TaskStore(kv);
  const localIngress = new LocalChannelIngressRuntime({
    workerPool: pool,
    taskStore,
  });
  const channelIngress = new InProcessBrokerChannelIngressClient(localIngress);

  const bus = new MessageBus(kv);
  const session = new SessionManager(kv);
  const channels = new ChannelManager(bus);

  const gateway = new Gateway(config, {
    bus,
    session,
    channels,
    channelIngress,
    workerPool: pool,
    kv,
  });
  await gateway.start();

  // Resolve the actual port (Deno.serve with port:0 picks a random port)
  // The gateway binds on config.gateway.port — with port 0 it's random.
  // We need to find the actual port. Gateway doesn't expose it directly,
  // so we'll use a known port instead.
  // Actually, let's pick a random available port.
  const listener = Deno.listen({ port: 0 });
  const actualPort = (listener.addr as Deno.NetAddr).port;
  listener.close();

  // Restart gateway on the known port
  await gateway.stop();
  config.gateway = { port: actualPort };
  const gateway2 = new Gateway(config, {
    bus: new MessageBus(kv),
    session: new SessionManager(kv),
    channels: new ChannelManager(new MessageBus(kv)),
    channelIngress,
    workerPool: pool,
    kv,
  });
  await gateway2.start();

  const baseUrl = `http://localhost:${actualPort}`;

  const chat = async (
    agentId: string,
    message: string,
    sessionId?: string,
  ) => {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        agentId,
        ...(sessionId ? { sessionId } : {}),
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const body = await res.json();
    assert(res.ok, `POST /chat failed: ${res.status} ${JSON.stringify(body)}`);
    return body;
  };

  return {
    baseUrl,
    pool,
    gateway: gateway2,
    kv,
    tmpDir,
    chat,
    stop: async () => {
      await gateway2.stop();
      pool.shutdown();
      cronKv.close();
      kv.close();
      await Deno.remove(kvPath).catch(() => {});
      await Deno.remove(cronKvPath).catch(() => {});
    },
  };
}

// ── Tests ───────────────────────────────────────────────

Deno.test({
  name: "Gateway E2E: health endpoint responds",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "health-agent", {
        soul: "You are a test agent.",
      });
      const harness = await startGatewayHarness(tmpDir, ["health-agent"]);
      try {
        const res = await fetch(`${harness.baseUrl}/health`);
        assertEquals(res.status, 200);
        const body = await res.json();
        assertExists(body.status);
      } finally {
        await harness.stop();
      }
    });
  },
});

Deno.test({
  name: "Gateway E2E: agent replies to a simple message",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "echo-agent", {
        soul:
          "You are a test agent. When the user says 'Reply with exactly: PONG', reply with exactly: PONG",
      });
      const harness = await startGatewayHarness(tmpDir, ["echo-agent"]);
      try {
        const result = await harness.chat(
          "echo-agent",
          "Reply with exactly: PONG",
        );
        assertEquals(result.task.status.state, "COMPLETED");
        assertStringIncludes(result.response, "PONG");
      } finally {
        await harness.stop();
      }
    });
  },
});

Deno.test({
  name: "Gateway E2E: shell tool executes in sandbox",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "shell-agent", {
        soul:
          "You are a test agent. When asked, use the shell tool to execute the exact command given. Return the output verbatim.",
        permissions: ["run", "read"],
      });
      const harness = await startGatewayHarness(tmpDir, ["shell-agent"]);
      try {
        const result = await harness.chat(
          "shell-agent",
          "Execute this shell command and return its output: echo E2E_GATEWAY_SUCCESS",
        );
        assertEquals(result.task.status.state, "COMPLETED");
        assertStringIncludes(result.response, "E2E_GATEWAY_SUCCESS");
      } finally {
        await harness.stop();
      }
    });
  },
});

Deno.test({
  name: "Gateway E2E: agent reads a file via read_file tool",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "reader-agent", {
        soul:
          "You are a test agent. When asked to read a file, use the read_file tool and return its contents verbatim.",
        permissions: ["read"],
      });
      // Write a file the agent can read
      await Deno.writeTextFile(
        `${tmpDir}/reader-agent/test-data.txt`,
        "GATEWAY_READ_SUCCESS_42",
      );
      const harness = await startGatewayHarness(tmpDir, ["reader-agent"]);
      try {
        const result = await harness.chat(
          "reader-agent",
          "Read the file 'test-data.txt' in your workspace and return its contents exactly.",
        );
        assertEquals(result.task.status.state, "COMPLETED");
        assertStringIncludes(result.response, "GATEWAY_READ_SUCCESS_42");
      } finally {
        await harness.stop();
      }
    });
  },
});

Deno.test({
  name: "Gateway E2E: agent stores and recalls memory",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "mem-agent", {
        soul:
          "You are a test agent. When asked to remember something, use the memory tool with action 'remember'. When asked to recall, use the memory tool with action 'recall' and return the facts verbatim.",
        permissions: ["read", "write"],
      });
      const harness = await startGatewayHarness(tmpDir, ["mem-agent"]);
      try {
        const sessionId = crypto.randomUUID();
        const storeResult = await harness.chat(
          "mem-agent",
          "Remember this fact with topic 'facts': 'MEMORY_TEST_42_OK'",
          sessionId,
        );
        assertEquals(storeResult.task.status.state, "COMPLETED");

        const recallResult = await harness.chat(
          "mem-agent",
          "Recall all facts from topic 'facts'. Return them verbatim.",
          sessionId,
        );
        assertEquals(recallResult.task.status.state, "COMPLETED");
        assertStringIncludes(recallResult.response, "MEMORY_TEST_42_OK");
      } finally {
        await harness.stop();
      }
    });
  },
});

Deno.test({
  name: "Gateway E2E: inter-agent communication via send_to_agent",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "alpha", {
        soul:
          "You are agent alpha. When asked to get a message from beta, use the send_to_agent tool to send 'Reply with exactly: INTER_AGENT_OK' to agent 'beta'. Return beta's response verbatim.",
        permissions: ["read"],
        peers: ["beta"],
      });
      await createAgent(tmpDir, "beta", {
        soul:
          "You are agent beta. When you receive a message, follow its instructions exactly.",
        permissions: ["read"],
        acceptFrom: ["alpha"],
      });
      const harness = await startGatewayHarness(tmpDir, ["alpha", "beta"]);
      try {
        const result = await harness.chat(
          "alpha",
          "Ask agent beta to reply with exactly: INTER_AGENT_OK. Return beta's response.",
        );
        assertEquals(result.task.status.state, "COMPLETED");
        assertStringIncludes(result.response, "INTER_AGENT_OK");
      } finally {
        await harness.stop();
      }
    });
  },
});

Deno.test({
  name: "Gateway E2E: agent writes a skill file",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "skill-agent", {
        soul:
          "You are a test agent. When asked to create a skill, use the write_file tool to write a markdown file in your skills/ directory. The file must have a YAML frontmatter with name and description fields, followed by the skill content.",
        permissions: ["read", "write"],
      });
      const harness = await startGatewayHarness(tmpDir, ["skill-agent"]);
      try {
        const result = await harness.chat(
          "skill-agent",
          "Create a skill file at 'skills/greet.md' with name 'greet', description 'A greeting skill', and content 'Always greet users warmly.'",
        );
        assertEquals(result.task.status.state, "COMPLETED");
        // Verify skill file was created
        const skillPath = `${tmpDir}/skill-agent/skills/greet.md`;
        const content = await Deno.readTextFile(skillPath).catch(() => "");
        assert(content.length > 0, "Expected skill file to be created");
        assertStringIncludes(content, "greet");
      } finally {
        await harness.stop();
      }
    });
  },
});

Deno.test({
  name: "Gateway E2E: session persistence across messages",
  ...gatewayTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      await createAgent(tmpDir, "session-agent", {
        soul:
          "You are a test agent with memory. Remember what users tell you within the conversation.",
      });
      const harness = await startGatewayHarness(tmpDir, ["session-agent"]);
      try {
        const sessionId = crypto.randomUUID();
        await harness.chat(
          "session-agent",
          "Remember this code: ALPHA_7X3. I will ask for it later.",
          sessionId,
        );
        const result2 = await harness.chat(
          "session-agent",
          "What was the code I told you to remember? Reply with just the code.",
          sessionId,
        );
        assertEquals(result2.task.status.state, "COMPLETED");
        assertStringIncludes(result2.response, "ALPHA_7X3");
      } finally {
        await harness.stop();
      }
    });
  },
});
