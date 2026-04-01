import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { AgentEntry } from "../shared/types.ts";
import {
  fetchCanonicalBrokerAgentConfig,
  loadWorkspaceSystemPrompt,
} from "./deploy_runtime.ts";

Deno.test("fetchCanonicalBrokerAgentConfig returns broker config payload", async () => {
  const config: AgentEntry = {
    model: "test/model",
    peers: ["agent-beta"],
  };
  let authHeader = "";

  const result = await fetchCanonicalBrokerAgentConfig({
    brokerUrl: "https://broker.example",
    authToken: "secret-token",
    agentId: "agent-alpha",
    fetchFn: ((input: string | URL | Request, init?: RequestInit) => {
      authHeader = new Headers(init?.headers).get("authorization") ?? "";
      assertEquals(
        String(input),
        "https://broker.example/agents/agent-alpha/config",
      );
      return Promise.resolve(
        Response.json({
          agentId: "agent-alpha",
          config,
        }),
      );
    }) as typeof fetch,
  });

  assertEquals(authHeader, "Bearer secret-token");
  assertEquals(result, config);
});

Deno.test("fetchCanonicalBrokerAgentConfig returns null for unknown agent", async () => {
  const result = await fetchCanonicalBrokerAgentConfig({
    brokerUrl: "https://broker.example",
    authToken: "secret-token",
    agentId: "agent-missing",
    fetchFn: (() =>
      Promise.resolve(
        Response.json(
          {
            error: { code: "AGENT_NOT_FOUND" },
          },
          { status: 404 },
        ),
      )) as typeof fetch,
  });

  assertEquals(result, null);
});

Deno.test("fetchCanonicalBrokerAgentConfig rejects invalid broker payloads", async () => {
  await assertRejects(
    () =>
      fetchCanonicalBrokerAgentConfig({
        brokerUrl: "https://broker.example",
        authToken: "secret-token",
        agentId: "agent-alpha",
        fetchFn: (() =>
          Promise.resolve(
            Response.json({
              agentId: "agent-alpha",
            }),
          )) as typeof fetch,
      }),
    Error,
    "Broker must return",
  );
});

Deno.test("loadWorkspaceSystemPrompt reads soul.md from workspace KV", async () => {
  const tmpDir = await Deno.makeTempDir();
  const kv = await Deno.openKv(join(tmpDir, "workspace.db"));

  try {
    await kv.set(["workspace", "agent-alpha", "soul.md"], "You are synced.\n");

    const result = await loadWorkspaceSystemPrompt({
      kv,
      agentId: "agent-alpha",
    });

    assertEquals(result, "You are synced.\n");
  } finally {
    kv.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
