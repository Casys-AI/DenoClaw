import { assertEquals } from "@std/assert";
import type { BrokerMessage } from "../types.ts";
import type { AgentStatusValue } from "../monitoring_types.ts";
import { BrokerMessageRuntime } from "./message_runtime.ts";
import type { BrokerMessageRuntimeDeps } from "./message_runtime.ts";

function makeDeps(
  overrides: Partial<BrokerMessageRuntimeDeps>,
): BrokerMessageRuntimeDeps {
  return {
    llmProxy: {
      handleRequest: () => Promise.resolve(),
    } as unknown as BrokerMessageRuntimeDeps["llmProxy"],
    toolDispatcher: {
      handleToolRequest: () => Promise.resolve(),
    } as unknown as BrokerMessageRuntimeDeps["toolDispatcher"],
    replyDispatcher: {
      sendTaskResult: () => Promise.resolve(),
      sendReply: () => Promise.resolve(),
    } as unknown as BrokerMessageRuntimeDeps["replyDispatcher"],
    taskDispatcher: {
      recordTaskResult: () => Promise.resolve(null),
    } as unknown as BrokerMessageRuntimeDeps["taskDispatcher"],
    federationRuntime: {
      handleControlMessage: () => Promise.resolve(),
    } as unknown as BrokerMessageRuntimeDeps["federationRuntime"],
    sendStructuredError: () => Promise.resolve(),
    ...overrides,
  };
}

function makeTaskResultMsg(fromAgent = "agent-beta"): BrokerMessage {
  return {
    id: "msg-001",
    from: fromAgent,
    to: "broker",
    type: "task_result",
    payload: { task: null },
    timestamp: new Date().toISOString(),
  };
}

Deno.test(
  "BrokerMessageRuntime writes agent liveness to KV on task_result",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const livenessWrites: string[] = [];

      const runtime = new BrokerMessageRuntime(
        makeDeps({
          writeAgentLiveness: async (agentId: string) => {
            livenessWrites.push(agentId);
            await kv.set(["agents", agentId, "status"], {
              status: "alive",
              lastHeartbeat: new Date().toISOString(),
            } satisfies AgentStatusValue);
          },
        }),
      );

      await runtime.handleMessage(makeTaskResultMsg("agent-beta"));

      // Allow the fire-and-forget liveness write to settle
      await new Promise((r) => setTimeout(r, 10));

      assertEquals(livenessWrites, ["agent-beta"]);

      const entry = await kv.get<AgentStatusValue>([
        "agents",
        "agent-beta",
        "status",
      ]);
      assertEquals(entry.value?.status, "alive");
      assertEquals(typeof entry.value?.lastHeartbeat, "string");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerMessageRuntime does not fail task_result when writeAgentLiveness is absent",
  async () => {
    const runtime = new BrokerMessageRuntime(makeDeps({}));
    // Should complete without throwing
    await runtime.handleMessage(makeTaskResultMsg("agent-gamma"));
  },
);

Deno.test(
  "BrokerMessageRuntime does not propagate liveness write errors",
  async () => {
    const runtime = new BrokerMessageRuntime(
      makeDeps({
        writeAgentLiveness: () => Promise.reject(new Error("KV_DOWN")),
      }),
    );
    // Should complete without throwing even when liveness write fails
    await runtime.handleMessage(makeTaskResultMsg("agent-delta"));
    await new Promise((r) => setTimeout(r, 10));
  },
);
