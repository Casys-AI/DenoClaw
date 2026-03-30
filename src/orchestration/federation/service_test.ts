import { assertEquals } from "@std/assert";
import type { BrokerTaskSubmitPayload } from "../types.ts";
import { FederationService } from "./service.ts";
import { KvFederationAdapter } from "./adapters/kv_adapter.ts";
import {
  generateCatalogSigningKeyPair,
  signCatalogEnvelope,
} from "./crypto.ts";
import type {
  CrossBrokerHopEvent,
  FederationObservabilityPort,
  FederationRoutingPort,
} from "./ports.ts";
import type { FederatedRoutePolicy } from "./types.ts";

class FlakyRoutingPort implements FederationRoutingPort {
  public calls = 0;
  constructor(private readonly failuresBeforeSuccess: number) {}

  resolveTarget(_task: BrokerTaskSubmitPayload, _policy: FederatedRoutePolicy) {
    return Promise.resolve({
      kind: "remote" as const,
      remoteBrokerId: "broker-b",
      reason: "test",
    });
  }

  forwardTask(): Promise<void> {
    this.calls += 1;
    if (this.calls <= this.failuresBeforeSuccess) {
      return Promise.reject(new Error("temporary_network_error"));
    }
    return Promise.resolve();
  }
}

class DelayedRoutingPort implements FederationRoutingPort {
  public calls = 0;

  resolveTarget(_task: BrokerTaskSubmitPayload, _policy: FederatedRoutePolicy) {
    return Promise.resolve({
      kind: "remote" as const,
      remoteBrokerId: "broker-b",
      reason: "test",
    });
  }

  async forwardTask(): Promise<void> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

class InMemoryObservabilityPort implements FederationObservabilityPort {
  public events: CrossBrokerHopEvent[] = [];

  recordCrossBrokerHop(event: CrossBrokerHopEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  streamFederationEvents(
    _onEvent: (event: CrossBrokerHopEvent) => void,
  ): Promise<() => void> {
    return Promise.resolve(() => {});
  }
}

Deno.test(
  "FederationService.probeRoute applies requester and remote policies",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const adapter = new KvFederationAdapter(kv);
      const service = new FederationService(adapter, adapter, adapter, adapter);

      await adapter.setRemoteCatalog("broker-b", [
        {
          remoteBrokerId: "broker-b",
          agentId: "agent-1",
          card: {},
          capabilities: [],
          visibility: "public",
        },
      ]);

      await adapter.setRoutePolicy("broker-a", {
        policyId: "broker-a",
        preferLocal: false,
        preferredRemoteBrokerIds: ["broker-b"],
        denyAgentIds: ["agent-denied-by-requester"],
        allowAgentIds: ["agent-1"],
      });

      await adapter.setRoutePolicy("broker-b", {
        policyId: "broker-b",
        preferLocal: false,
        preferredRemoteBrokerIds: ["broker-a"],
        denyAgentIds: ["agent-denied-by-remote"],
        allowAgentIds: ["agent-1", "agent-denied-by-remote"],
      });

      const accepted = await service.probeRoute({
        requesterBrokerId: "broker-a",
        remoteBrokerId: "broker-b",
        targetAgent: "agent-1",
      });
      assertEquals(accepted.accepted, true);
      assertEquals(accepted.reason, "route_available");

      const deniedByRequester = await service.probeRoute({
        requesterBrokerId: "broker-a",
        remoteBrokerId: "broker-b",
        targetAgent: "agent-denied-by-requester",
      });
      assertEquals(deniedByRequester.accepted, false);
      assertEquals(deniedByRequester.reason, "denied_by_policy");

      const deniedByRemote = await service.probeRoute({
        requesterBrokerId: "broker-a",
        remoteBrokerId: "broker-b",
        targetAgent: "agent-denied-by-remote",
      });
      assertEquals(deniedByRemote.accepted, false);
      assertEquals(deniedByRemote.reason, "denied_by_policy");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService manages broker identities through identity port",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const adapter = new KvFederationAdapter(kv);
      const service = new FederationService(adapter, adapter, adapter, adapter);

      await service.upsertIdentity({
        brokerId: "broker-c",
        instanceUrl: "https://broker-c.example.com",
        publicKeys: ["pub-1", "pub-2"],
        status: "trusted",
      });

      const one = await service.getIdentity("broker-c");
      assertEquals(one?.publicKeys.length, 2);

      const all = await service.listIdentities();
      assertEquals(all.length, 1);

      await service.revokeIdentity("broker-c");
      const revoked = await service.getIdentity("broker-c");
      assertEquals(revoked?.status, "revoked");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService.syncSignedCatalog accepts trusted signed catalogs",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const keys = await generateCatalogSigningKeyPair();
      const adapter = new KvFederationAdapter(kv);
      const service = new FederationService(adapter, adapter, adapter, adapter);

      await service.upsertIdentity({
        brokerId: "broker-b",
        instanceUrl: "https://broker-b.example.com",
        publicKeys: [keys.publicKey],
        status: "trusted",
      });

      const signedEnvelope = await signCatalogEnvelope(
        {
          remoteBrokerId: "broker-b",
          schemaVersion: 1,
          signedAt: new Date().toISOString(),
          entries: [
            {
              remoteBrokerId: "broker-b",
              agentId: "agent-signed",
              card: { name: "Signed Agent" },
              capabilities: ["chat"],
              visibility: "public",
            },
          ],
        },
        keys.privateKey,
      );

      await service.syncSignedCatalog(signedEnvelope);
      const card = await adapter.getRemoteAgentCard("broker-b", "agent-signed");
      assertEquals(card?.name, "Signed Agent");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService.syncSignedCatalog rejects invalid signature",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const trustedKeys = await generateCatalogSigningKeyPair();
      const attackerKeys = await generateCatalogSigningKeyPair();
      const adapter = new KvFederationAdapter(kv);
      const service = new FederationService(adapter, adapter, adapter, adapter);

      await service.upsertIdentity({
        brokerId: "broker-b",
        instanceUrl: "https://broker-b.example.com",
        publicKeys: [trustedKeys.publicKey],
        status: "trusted",
      });

      const signedEnvelope = await signCatalogEnvelope(
        {
          remoteBrokerId: "broker-b",
          schemaVersion: 1,
          signedAt: new Date().toISOString(),
          entries: [
            {
              remoteBrokerId: "broker-b",
              agentId: "agent-signed",
              card: {},
              capabilities: [],
              visibility: "public",
            },
          ],
        },
        attackerKeys.privateKey,
      );

      let thrown = false;
      try {
        await service.syncSignedCatalog(signedEnvelope);
      } catch {
        thrown = true;
      }
      assertEquals(thrown, true);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService.evaluateRouteAuthorization distinguishes local and remote denials",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const service = new FederationService(adapter, adapter, adapter, adapter);

      await adapter.setRemoteCatalog("broker-b", [
        {
          remoteBrokerId: "broker-b",
          agentId: "agent-1",
          card: {},
          capabilities: [],
          visibility: "public",
        },
      ]);

      await adapter.setRoutePolicy("broker-a", {
        policyId: "broker-a",
        preferLocal: false,
        preferredRemoteBrokerIds: ["broker-b"],
        denyAgentIds: ["agent-local-denied"],
      });
      await adapter.setRoutePolicy("broker-b", {
        policyId: "broker-b",
        preferLocal: false,
        preferredRemoteBrokerIds: ["broker-a"],
        denyAgentIds: ["agent-remote-denied"],
      });

      const localDenied = await service.evaluateRouteAuthorization({
        requesterBrokerId: "broker-a",
        remoteBrokerId: "broker-b",
        targetAgent: "agent-local-denied",
      });
      assertEquals(localDenied.decision, "DENY_LOCAL_POLICY");

      const remoteDenied = await service.evaluateRouteAuthorization({
        requesterBrokerId: "broker-a",
        remoteBrokerId: "broker-b",
        targetAgent: "agent-remote-denied",
      });
      assertEquals(remoteDenied.decision, "DENY_REMOTE_POLICY");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService.forwardTaskIdempotent retries then succeeds",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new FlakyRoutingPort(1);
      const observability = new InMemoryObservabilityPort();
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
        observability,
      );

      const task: BrokerTaskSubmitPayload = {
        targetAgent: "agent-1",
        taskId: "task-42",
        taskMessage: {
          messageId: "msg-42",
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
        },
      };

      const result = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task,
        maxAttempts: 3,
        linkId: "broker-a:broker-b",
      });
      assertEquals(result.status, "forwarded");
      assertEquals(result.attempts, 2);
      assertEquals(observability.events.length, 2);
      assertEquals(observability.events[0].success, false);
      assertEquals(observability.events[1].success, true);
      assertEquals(observability.events[0].linkId, "broker-a:broker-b");

      const deduplicated = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task,
        maxAttempts: 3,
      });
      assertEquals(deduplicated.status, "deduplicated");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService.forwardTaskIdempotent is Unicode-safe and uses compact hashes",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new FlakyRoutingPort(0);
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
      );

      const task: BrokerTaskSubmitPayload = {
        targetAgent: "agent-unicode",
        taskId: "task-unicode",
        taskMessage: {
          messageId: "msg-unicode",
          role: "user",
          parts: [{ kind: "text", text: "bonjour 👋 你好 café" }],
        },
      };

      const result = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task,
        maxAttempts: 1,
      });
      assertEquals(result.status, "forwarded");
      assertEquals(result.idempotencyKey.includes("bonjour"), false);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService.forwardTaskIdempotent moves to dead-letter after max attempts",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new FlakyRoutingPort(10);
      const observability = new InMemoryObservabilityPort();
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
        observability,
      );

      const task: BrokerTaskSubmitPayload = {
        targetAgent: "agent-1",
        taskId: "task-dead-letter",
        taskMessage: {
          messageId: "msg-dead-letter",
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
        },
      };

      const result = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task,
        maxAttempts: 2,
        linkId: "broker-a:broker-b",
      });
      assertEquals(result.status, "dead_letter");
      assertEquals(result.attempts, 2);

      const deadLetters = await adapter.listDeadLetters("broker-b");
      assertEquals(deadLetters.length, 1);
      assertEquals(observability.events.length, 2);
      assertEquals(
        observability.events.every((event) => !event.success),
        true,
      );

      const replay = await service.forwardTaskIdempotent({
        remoteBrokerId: "broker-b",
        task,
        maxAttempts: 2,
        linkId: "broker-a:broker-b",
      });
      assertEquals(replay.status, "dead_letter");
      assertEquals((await adapter.listDeadLetters("broker-b")).length, 1);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService.forwardTaskIdempotent deduplicates concurrent submissions",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const routing = new DelayedRoutingPort();
      const service = new FederationService(
        adapter,
        adapter,
        adapter,
        adapter,
        routing,
        adapter,
      );

      const task: BrokerTaskSubmitPayload = {
        targetAgent: "agent-1",
        taskId: "task-concurrent",
        taskMessage: {
          messageId: "msg-concurrent",
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
        },
      };

      const [first, second] = await Promise.all([
        service.forwardTaskIdempotent({
          remoteBrokerId: "broker-b",
          task,
          maxAttempts: 1,
        }),
        service.forwardTaskIdempotent({
          remoteBrokerId: "broker-b",
          task,
          maxAttempts: 1,
        }),
      ]);

      assertEquals([first.status, second.status].sort(), [
        "deduplicated",
        "forwarded",
      ]);
      assertEquals(routing.calls, 1);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "FederationService rotates identity key and session via ports",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const service = new FederationService(adapter, adapter, adapter, adapter);

      await service.openLink({
        linkId: "broker-a:broker-b",
        localBrokerId: "broker-a",
        remoteBrokerId: "broker-b",
        requestedBy: "broker-a",
      });

      const identity = await service.rotateIdentityKey(
        "broker-b",
        "pub-key-v2",
      );
      assertEquals(identity.activeKeyId, "pub-key-v2");

      const session = await service.rotateLinkSession("broker-a:broker-b", 120);
      assertEquals(session.linkId, "broker-a:broker-b");
      assertEquals(session.status, "active");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);
