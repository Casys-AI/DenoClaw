/**
 * Deploy E2E tests — smoke tests against a live deployed broker.
 *
 * Requires:
 *   - DENOCLAW_BROKER_URL or config.deploy.url (the deployed broker HTTPS URL)
 *   - DENOCLAW_API_TOKEN (bearer token for authenticated endpoints)
 *
 * These tests are skipped when the broker is unreachable.
 * Run: deno test tests/deploy_e2e_test.ts --unstable-kv --allow-all --env
 */
import "@std/dotenv/load";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { getConfigOrDefault } from "../src/config/loader.ts";

const TEST_TIMEOUT_MS = 120_000;
const testOpts = {
  sanitizeResources: false,
  sanitizeOps: false,
  sanitizeExit: false,
};

// ── Resolve broker URL and token ────────────────────────

async function resolveBrokerUrl(): Promise<string | null> {
  const envUrl = Deno.env.get("DENOCLAW_BROKER_URL");
  if (envUrl) return envUrl;
  try {
    const config = await getConfigOrDefault();
    return config.deploy?.url ?? null;
  } catch {
    return null;
  }
}

function resolveApiToken(): string | null {
  return Deno.env.get("DENOCLAW_API_TOKEN") ?? null;
}

const BROKER_URL = await resolveBrokerUrl();
const API_TOKEN = resolveApiToken();

async function canReachBroker(): Promise<boolean> {
  if (!BROKER_URL || !API_TOKEN) return false;
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const DEPLOY_E2E_ENABLED = await canReachBroker();
const deployTestOpts = {
  ...testOpts,
  ...(DEPLOY_E2E_ENABLED ? {} : { ignore: true }),
};

if (!DEPLOY_E2E_ENABLED) {
  console.log(
    `Deploy E2E: SKIPPED (broker=${BROKER_URL ?? "not set"}, token=${API_TOKEN ? "set" : "not set"})`,
  );
}

// ── Helpers ─────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_TOKEN}`,
  };
}

async function submitMessage(
  agentId: string,
  content: string,
  sessionId?: string,
): Promise<{ task: { id: string; status: { state: string }; artifacts: unknown[] } }> {
  const id = sessionId ?? crypto.randomUUID();
  const res = await fetch(`${BROKER_URL}/ingress/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      message: {
        id: crypto.randomUUID(),
        sessionId: id,
        userId: "deploy-e2e-test",
        content,
        channelType: "http",
        timestamp: new Date().toISOString(),
        address: { channelType: "http", roomId: `e2e-${agentId}` },
      },
      route: { agentId },
    }),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  const body = await res.json();
  assert(
    res.ok,
    `POST /ingress/messages failed: ${res.status} ${JSON.stringify(body)}`,
  );
  return body;
}

async function getTask(
  taskId: string,
): Promise<{ task: { id: string; status: { state: string }; artifacts: unknown[] } }> {
  const res = await fetch(`${BROKER_URL}/ingress/tasks/${taskId}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  assert(
    res.ok,
    `GET /ingress/tasks/${taskId} failed: ${res.status} ${JSON.stringify(body)}`,
  );
  return body;
}


async function findFirstRealAgent(): Promise<string | null> {
  const res = await fetch(`${BROKER_URL}/stats/agents`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const data = await res.json();
  // Response is an array of { agentId, ... }
  const entries = Array.isArray(data) ? data : Object.values(data);
  for (const entry of entries) {
    const id = typeof entry === "string" ? entry : entry?.agentId;
    if (
      typeof id === "string" && id.length > 0 &&
      !id.startsWith("channel:") && !/^\d+$/.test(id)
    ) {
      return id;
    }
  }
  return null;
}

// ── Tests ───────────────────────────────────────────────

Deno.test({
  name: "Deploy E2E: broker health endpoint responds",
  ...deployTestOpts,
  async fn() {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.status, "ok");
    assertExists(body.tunnelCount);
  },
});

Deno.test({
  name: "Deploy E2E: broker rejects unauthenticated requests",
  ...deployTestOpts,
  async fn() {
    const res = await fetch(`${BROKER_URL}/ingress/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: {} }),
      signal: AbortSignal.timeout(10_000),
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  },
});

Deno.test({
  name: "Deploy E2E: stats endpoint returns metrics",
  ...deployTestOpts,
  async fn() {
    const res = await fetch(`${BROKER_URL}/stats`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body);
  },
});

Deno.test({
  name: "Deploy E2E: cron jobs endpoint responds",
  ...deployTestOpts,
  async fn() {
    const res = await fetch(`${BROKER_URL}/cron/jobs`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    // May be 200 or 404 depending on broker version
    if (res.status === 404) {
      await res.body?.cancel();
      console.log("Deploy E2E: /cron/jobs not available on this broker");
      return;
    }
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body);
  },
});

Deno.test({
  name: "Deploy E2E: agent responds to a message via ingress",
  ...deployTestOpts,
  async fn() {
    // This test requires at least one agent registered on the broker.
    const agentId = await findFirstRealAgent();
    if (!agentId) {
      console.log("Deploy E2E: no real agents found, skipping");
      return;
    }
    const result = await submitMessage(
      agentId,
      "Reply with exactly: DEPLOY_E2E_PONG",
    );
    assertExists(result.task);
    assertExists(result.task.id);

    // If task is not yet completed, poll for it
    let task = result.task;
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    while (
      task.status.state !== "COMPLETED" &&
      task.status.state !== "FAILED" &&
      task.status.state !== "REJECTED" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 2_000));
      const polled = await getTask(task.id);
      task = polled.task;
    }

    assertEquals(
      task.status.state,
      "COMPLETED",
      `Expected COMPLETED but got ${task.status.state}`,
    );
    const taskJson = JSON.stringify(task);
    assertStringIncludes(taskJson, "PONG");
  },
});

Deno.test({
  name: "Deploy E2E: task can be retrieved after submission",
  ...deployTestOpts,
  async fn() {
    const agentId = await findFirstRealAgent();
    if (!agentId) return;
    const result = await submitMessage(agentId, "Reply with exactly: TASK_POLL_OK");
    assertExists(result.task.id);

    // Poll until terminal
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    let task = result.task;
    while (
      task.status.state !== "COMPLETED" &&
      task.status.state !== "FAILED" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 2_000));
      const polled = await getTask(task.id);
      task = polled.task;
    }

    // Retrieve again — should still be there
    const retrieved = await getTask(task.id);
    assertEquals(retrieved.task.id, task.id);
    assertEquals(retrieved.task.status.state, task.status.state);
  },
});
