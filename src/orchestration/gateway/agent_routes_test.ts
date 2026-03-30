import { assertEquals } from "@std/assert";
import type { AgentEntry } from "../../shared/types.ts";
import type { WorkerPool } from "../../agent/worker_pool.ts";
import type { AgentStore } from "../agent_store.ts";
import { handleGatewayAgentRoute } from "./agent_routes.ts";

function createContext() {
  const registry: Record<string, AgentEntry> = {};
  const removed: string[] = [];

  return {
    registry,
    removed,
    ctx: {
      agentStore: {
        list: () => Promise.resolve({ ...registry }),
        set: (agentId: string, config: AgentEntry) => {
          registry[agentId] = config;
          return Promise.resolve();
        },
        get: (agentId: string) => Promise.resolve(registry[agentId] ?? null),
        delete: (agentId: string) => {
          const existed = agentId in registry;
          delete registry[agentId];
          return Promise.resolve(existed);
        },
      } as unknown as AgentStore,
      workerPool: {
        addAgent: () => Promise.resolve(),
        removeAgent: (agentId: string) => {
          removed.push(agentId);
        },
      } as unknown as Pick<WorkerPool, "addAgent" | "removeAgent">,
    },
  };
}

Deno.test("handleGatewayAgentRoute lists registered agents", async () => {
  const { ctx, registry } = createContext();
  registry.alice = { model: "test/model" };

  const res = await handleGatewayAgentRoute(
    ctx,
    new Request("http://localhost/api/agents"),
    new URL("http://localhost/api/agents"),
  );

  assertEquals(res?.status, 200);
  assertEquals(await res?.json(), {
    alice: { model: "test/model" },
  });
});

Deno.test("handleGatewayAgentRoute validates POST payloads", async () => {
  const { ctx } = createContext();

  const res = await handleGatewayAgentRoute(
    ctx,
    new Request("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ config: { model: "test/model" } }),
      headers: { "content-type": "application/json" },
    }),
    new URL("http://localhost/api/agents"),
  );

  assertEquals(res?.status, 400);
  assertEquals(await res?.json(), {
    error: {
      code: "INVALID_INPUT",
      recovery: "Provide agentId and config",
    },
  });
});

Deno.test("handleGatewayAgentRoute deletes agents and removes workers", async () => {
  const { ctx, registry, removed } = createContext();
  registry.alice = { model: "test/model" };

  const res = await handleGatewayAgentRoute(
    ctx,
    new Request("http://localhost/api/agents/alice", { method: "DELETE" }),
    new URL("http://localhost/api/agents/alice"),
  );

  assertEquals(res?.status, 200);
  assertEquals(await res?.json(), { ok: true, agentId: "alice" });
  assertEquals(removed, ["alice"]);
  assertEquals(registry, {});
});
