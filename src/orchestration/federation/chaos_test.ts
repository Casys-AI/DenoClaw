import { assertEquals } from "@std/assert";
import type { BrokerTaskSubmitPayload } from "../types.ts";
import { KvFederationAdapter } from "./adapters/kv_adapter.ts";
import type { FederationRoutingPort } from "./ports.ts";
import { FederationService } from "./service.ts";
import type {
  FederatedRoutePolicy,
  FederationCorrelationContext,
} from "./types.ts";

class ScenarioRoutingPort implements FederationRoutingPort {
  private calls = 0;
  constructor(
    private readonly behavior: (callNumber: number) => Promise<void>,
  ) {}

  resolveTarget(
    _task: BrokerTaskSubmitPayload,
    _policy: FederatedRoutePolicy,
    _correlation: FederationCorrelationContext,
  ) {
    return Promise.resolve({
      kind: "remote" as const,
      remoteBrokerId: "broker-b",
      reason: "chaos",
    });
  }

  async forwardTask(
    _task: BrokerTaskSubmitPayload,
    _remoteBrokerId: string,
    _correlation: FederationCorrelationContext,
  ): Promise<void> {
    this.calls += 1;
    await this.behavior(this.calls);
  }
}

function sampleTask(taskId: string): BrokerTaskSubmitPayload & { contextId: string } {
  return {
    targetAgent: "agent-1",
    taskId,
    contextId: `ctx-${taskId}`,
    taskMessage: {
      messageId: `msg-${taskId}`,
      role: "user",
      parts: [{ kind: "text", text: "run chaos scenario" }],
    },
  };
}

Deno.test(
  "chaos: transient link drop eventually recovers without dead-letter",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new ScenarioRoutingPort((callNumber) => {
        if (callNumber < 3) {
          return Promise.reject(new Error("link_dropped"));
        }
        return Promise.resolve();
      });
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
        adapter,
      );

      const result = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task: sampleTask("task-link-drop"),
        maxAttempts: 3,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        linkId: "broker-a:broker-b",
        traceId: "trace-link-drop",
      });

      assertEquals(result.status, "forwarded");
      const deadLetters = await adapter.listDeadLetters("broker-b");
      assertEquals(deadLetters.length, 0);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "chaos: sustained high latency eventually dead-letters when remote stays failing",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new ScenarioRoutingPort(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("remote_timeout");
      });
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
        adapter,
      );

      const result = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task: sampleTask("task-high-latency"),
        maxAttempts: 2,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        linkId: "broker-a:broker-b",
        traceId: "trace-high-latency",
      });

      assertEquals(result.status, "dead_letter");
      const deadLetters = await adapter.listDeadLetters("broker-b");
      assertEquals(deadLetters.length, 1);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "chaos: expired session/token pushes terminal failure to dead-letter",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new ScenarioRoutingPort(() =>
        Promise.reject(new Error("token_expired"))
      );
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
        adapter,
      );

      const result = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task: sampleTask("task-token-expired"),
        maxAttempts: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        linkId: "broker-a:broker-b",
        traceId: "trace-token-expired",
      });

      assertEquals(result.status, "dead_letter");
      const deadLetters = await adapter.listDeadLetters("broker-b");
      assertEquals(deadLetters[0].reason.includes("token_expired"), true);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "chaos: remote unavailable keeps idempotency intact on replay",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new ScenarioRoutingPort(() =>
        Promise.reject(new Error("remote_unavailable"))
      );
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
        adapter,
      );

      const task = sampleTask("task-remote-down");
      const first = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task,
        maxAttempts: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        linkId: "broker-a:broker-b",
        traceId: "trace-remote-down",
      });
      const second = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task,
        maxAttempts: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        linkId: "broker-a:broker-b",
        traceId: "trace-remote-down",
      });

      assertEquals(first.idempotencyKey, second.idempotencyKey);
      assertEquals(first.status, "dead_letter");
      assertEquals(second.status, "dead_letter");
      assertEquals((await adapter.listDeadLetters("broker-b")).length, 1);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);
