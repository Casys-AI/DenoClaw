import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { KvFederationAdapter } from "./kv_adapter.ts";

Deno.test("KvFederationAdapter link lifecycle", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    const link = await adapter.establishLink({
      localBrokerId: "broker-a",
      remoteBrokerId: "broker-b",
      requestedBy: "broker-a",
      correlation: {
        linkId: "broker-a:broker-b",
        remoteBrokerId: "broker-b",
        traceId: "trace-link-1",
      },
    });

    assertEquals(link.state, "active");
    const links = await adapter.listLinks();
    assertEquals(links.length, 1);

    await adapter.setLinkState(link.linkId, "failed", {
      linkId: link.linkId,
      remoteBrokerId: "broker-b",
      traceId: "trace-link-2",
    });
    const failed = (await adapter.listLinks())[0];
    assertEquals(failed.state, "failed");

    await adapter.terminateLink(link.linkId, {
      linkId: link.linkId,
      remoteBrokerId: "broker-b",
      traceId: "trace-link-3",
    });
    assertEquals((await adapter.listLinks()).length, 0);
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("KvFederationAdapter catalog lookup", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    await adapter.setRemoteCatalog(
      "broker-b",
      [
        {
          remoteBrokerId: "broker-b",
          agentId: "agent-1",
          card: { name: "Agent 1" },
          capabilities: ["chat"],
          visibility: "public",
        },
      ],
      {
        remoteBrokerId: "broker-b",
        traceId: "trace-catalog-1",
      },
    );

    const card = await adapter.getRemoteAgentCard("broker-b", "agent-1", {
      remoteBrokerId: "broker-b",
      traceId: "trace-catalog-2",
    });
    assertExists(card);
    assertEquals(card?.name, "Agent 1");
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("KvFederationAdapter stores and reads route policy", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    await adapter.setRoutePolicy(
      "broker-a",
      {
        policyId: "broker-a",
        preferLocal: true,
        preferredRemoteBrokerIds: ["broker-b"],
        denyAgentIds: ["agent-denied"],
        allowAgentIds: ["agent-allowed"],
        maxLatencyMs: 2000,
      },
      {
        remoteBrokerId: "broker-a",
        traceId: "trace-policy-1",
      },
    );

    const policy = await adapter.getRoutePolicy("broker-a", {
      remoteBrokerId: "broker-a",
      traceId: "trace-policy-2",
    });
    assertExists(policy);
    assertEquals(policy?.preferredRemoteBrokerIds, ["broker-b"]);
    assertEquals(policy?.denyAgentIds, ["agent-denied"]);
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("KvFederationAdapter identity lifecycle", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    await adapter.upsertIdentity({
      brokerId: "broker-a",
      instanceUrl: "https://broker-a.example.com",
      publicKeys: ["key-1"],
      status: "trusted",
    });

    const stored = await adapter.getIdentity("broker-a");
    assertExists(stored);
    assertEquals(stored?.status, "trusted");

    const all = await adapter.listIdentities();
    assertEquals(all.length, 1);

    await adapter.revokeIdentity("broker-a");
    const revoked = await adapter.getIdentity("broker-a");
    assertEquals(revoked?.status, "revoked");
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test(
  "KvFederationAdapter submission + dead-letter lifecycle",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const correlation = {
        remoteBrokerId: "broker-b",
        taskId: "task-1",
        contextId: "ctx-1",
        linkId: "broker-a:broker-b",
        traceId: "trace-1",
      };
      const created = await adapter.createSubmissionRecord({
        idempotencyKey: "broker-b:task-1:hash-1",
        remoteBrokerId: "broker-b",
        taskId: "task-1",
        contextId: "ctx-1",
        linkId: "broker-a:broker-b",
        traceId: "trace-1",
        payloadHash: "hash-1",
        status: "in_flight",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 1,
      }, correlation);
      assertEquals(created, true);

      const duplicate = await adapter.createSubmissionRecord({
        idempotencyKey: "broker-b:task-1:hash-1",
        remoteBrokerId: "broker-b",
        taskId: "task-1",
        contextId: "ctx-should-not-overwrite",
        linkId: "broker-a:broker-b",
        traceId: "trace-duplicate",
        payloadHash: "hash-1",
        status: "in_flight",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 99,
      }, {
        ...correlation,
        contextId: "ctx-should-not-overwrite",
        traceId: "trace-duplicate",
      });
      assertEquals(duplicate, false);

      const record = await adapter.getSubmissionRecord(
        "broker-b:task-1:hash-1",
        correlation,
      );
      assertEquals(record?.attempts, 1);
      assertEquals(record?.contextId, "ctx-1");
      assertEquals(record?.linkId, "broker-a:broker-b");
      assertEquals(record?.traceId, "trace-1");

      await adapter.moveToDeadLetter({
        deadLetterId: "dead-1",
        idempotencyKey: "broker-b:task-1:hash-1",
        remoteBrokerId: "broker-b",
        taskId: "task-1",
        contextId: "ctx-1",
        linkId: "broker-a:broker-b",
        traceId: "trace-1",
        payloadHash: "hash-1",
        reason: "network_timeout",
        movedAt: new Date().toISOString(),
      }, correlation);
      const deadLetters = await adapter.listDeadLetters("broker-b");
      assertEquals(deadLetters.length, 1);
      assertEquals(deadLetters[0].reason, "network_timeout");
      assertEquals(deadLetters[0].traceId, "trace-1");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "KvFederationAdapter streams federation events to subscribers",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      const seen: string[] = [];
      const unsubscribe = await adapter.streamFederationEvents((event) => {
        seen.push(event.taskId);
      });

      await adapter.recordCrossBrokerHop({
        linkId: "broker-a:broker-b",
        remoteBrokerId: "broker-b",
        taskId: "task-stream-1",
        contextId: "ctx-1",
        traceId: "trace-stream-1",
        latencyMs: 12,
        success: true,
        occurredAt: new Date().toISOString(),
      });

      unsubscribe();

      await adapter.recordCrossBrokerHop({
        linkId: "broker-a:broker-b",
        remoteBrokerId: "broker-b",
        taskId: "task-stream-2",
        contextId: "ctx-2",
        traceId: "trace-stream-2",
        latencyMs: 10,
        success: true,
        occurredAt: new Date().toISOString(),
      });

      assertEquals(seen, ["task-stream-1"]);
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "KvFederationAdapter computes federation stats snapshot",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      await adapter.recordCrossBrokerHop({
        linkId: "broker-a:broker-b",
        remoteBrokerId: "broker-b",
        taskId: "task-1",
        contextId: "ctx-1",
        traceId: "trace-1",
        latencyMs: 10,
        success: true,
        occurredAt: "2026-03-30T00:00:01.000Z",
      });
      await adapter.recordCrossBrokerHop({
        linkId: "broker-a:broker-b",
        remoteBrokerId: "broker-b",
        taskId: "task-2",
        contextId: "ctx-2",
        traceId: "trace-2",
        latencyMs: 20,
        success: true,
        occurredAt: "2026-03-30T00:00:02.000Z",
      });
      await adapter.recordCrossBrokerHop({
        linkId: "broker-a:broker-b",
        remoteBrokerId: "broker-b",
        taskId: "task-3",
        contextId: "ctx-3",
        traceId: "trace-3",
        latencyMs: 30,
        success: false,
        errorCode: "timeout",
        occurredAt: "2026-03-30T00:00:03.000Z",
      });
      await adapter.moveToDeadLetter({
        deadLetterId: "dead-stats",
        idempotencyKey: "broker-b:task-3:hash",
        remoteBrokerId: "broker-b",
        taskId: "task-3",
        contextId: "ctx-3",
        linkId: "broker-a:broker-b",
        traceId: "trace-3",
        payloadHash: "hash",
        reason: "timeout",
        movedAt: new Date().toISOString(),
      }, {
        remoteBrokerId: "broker-b",
        taskId: "task-3",
        contextId: "ctx-3",
        linkId: "broker-a:broker-b",
        traceId: "trace-3",
      });

      const stats = await adapter.getFederationStats("broker-b");
      assertEquals(stats.successCount, 2);
      assertEquals(stats.errorCount, 1);
      assertEquals(stats.deadLetterBacklog, 1);
      assertEquals(stats.links.length, 1);
      assertEquals(stats.links[0].p50LatencyMs, 20);
      assertEquals(stats.links[0].p95LatencyMs, 30);
      assertEquals(stats.links[0].lastTaskId, "task-3");
      assertEquals(stats.links[0].lastTraceId, "trace-3");
      assertEquals(typeof stats.links[0].lastOccurredAt, "string");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "KvFederationAdapter rotates identity key and link session",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    try {
      const adapter = new KvFederationAdapter(kv);
      await adapter.establishLink({
        linkId: "broker-a:broker-b",
        localBrokerId: "broker-a",
        remoteBrokerId: "broker-b",
        requestedBy: "broker-a",
        correlation: {
          linkId: "broker-a:broker-b",
          remoteBrokerId: "broker-b",
          traceId: "trace-link-4",
        },
      });

      const rotatedIdentity = await adapter.rotateIdentityKey(
        "broker-b",
        "pub-key-v2",
      );
      assertEquals(rotatedIdentity.activeKeyId, "pub-key-v2");
      assertEquals(rotatedIdentity.publicKeys[0], "pub-key-v2");

      const session = await adapter.rotateLinkSession("broker-a:broker-b", {
        linkId: "broker-a:broker-b",
        remoteBrokerId: "broker-b",
        traceId: "trace-session-1",
      }, 60);
      assertEquals(session.linkId, "broker-a:broker-b");
      assertEquals(session.remoteBrokerId, "broker-b");
      assertEquals(session.status, "active");

      await assertRejects(
        () =>
          adapter.rotateLinkSession("broker-a:broker-b", {
            linkId: "broker-a:broker-b",
            remoteBrokerId: "broker-b",
            traceId: "trace-session-2",
          }, 0),
        Error,
        "ttlSeconds must be a positive number",
      );
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);
