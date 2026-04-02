# Federation A2A Consolidation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align DenoClaw federation internals with the A2A protocol so that the data plane is fully A2A-shaped end-to-end — Agent Cards propagated, peer messaging returning Tasks, SSE spec-compliant — and the federation layer becomes interoperable with external A2A agents. Fix SEC-19 (catalog sync bypasses ECDSA verification) as part of the consolidation.

**Architecture:** The external HTTP surface (`A2AServer`/`A2AClient`) is already A2A-compliant. The internal broker transport stays as `BrokerMessage` envelopes over WebSocket (intentional, ADR-011). The consolidation targets the **payload shapes and discovery data** flowing through the internal transport, not the transport itself. Six areas: (1) typed AgentCards in federation catalog, (2) AgentCard propagation through catalog sync, (3) SEC-19 fix — verify broker identity before accepting catalog sync from instance tunnels, (4) peer messaging aligned to A2A Task results, (5) SSE spec compliance, (6) deprecated alias cleanup.

**Tech Stack:** Deno, Deno KV, A2A JSON-RPC 2.0, existing `src/messaging/a2a/` + `src/orchestration/federation/`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/orchestration/federation/types.ts` | `RemoteAgentCatalogEntry.card` typed as `AgentCard \| null` |
| Modify | `src/orchestration/federation/ports.ts` | `getRemoteAgentCard` returns `AgentCard \| null` |
| Modify | `src/orchestration/federation/adapters/tunnel_adapter.ts` | Accept + propagate `AgentCard` from tunnel capabilities |
| Modify | `src/orchestration/federation/adapters/kv_adapter.ts` | Store/retrieve typed `AgentCard` |
| Modify | `src/orchestration/broker/federation_control_handlers.ts` | Parse + propagate cards in `federation_catalog_sync` |
| Modify | `src/orchestration/types.ts` | `FederationCatalogSyncPayload.agents` becomes structured entries with cards; remove deprecated `message` aliases |
| Modify | `src/orchestration/broker/tunnel_upgrade.ts` | SEC-19: verify broker identity before catalog sync |
| Modify | `src/agent/worker_protocol.ts` | `peer_send`/`peer_response` carry optional A2A Task metadata; add `PeerResult` type |
| Modify | `src/agent/worker_pool_peer_router.ts` | Return structured A2A Task result instead of raw string |
| Modify | `src/agent/worker_runtime_peer_messenger.ts` | `sendToAgent` returns `PeerResult` instead of `string` |
| Modify | `src/agent/tools/send_to_agent.ts` | Update `SendToAgentFn` type + `execute()` to use `PeerResult.content` |
| Modify | `src/agent/loop.ts` | Update `AgentLoopDeps.sendToAgent` field type |
| Modify | `src/messaging/a2a/server.ts` | Remove custom `{ kind: "task" }` SSE frame |
| Modify | `src/messaging/a2a/internal_contract.ts` | Remove deprecated `message` aliases |
| Tests  | Existing test files + new tests as noted per task |

---

### Task 1: Type AgentCard in RemoteAgentCatalogEntry

**Files:**
- Modify: `src/orchestration/federation/types.ts:29-35`
- Modify: `src/orchestration/federation/ports.ts:66-71`
- Modify: `src/orchestration/federation/adapters/kv_adapter.ts:166` (return type annotation)
- Test: `src/orchestration/federation/adapters/kv_adapter_test.ts` (update fixture)
- Test: `src/orchestration/federation/adapters/tunnel_adapter_test.ts`

- [ ] **Step 1: Write the failing test**

In `src/orchestration/federation/adapters/tunnel_adapter_test.ts`, add:

```typescript
Deno.test("mapInstanceTunnelToCatalog sets card to null when no card available", () => {
  const entries = mapInstanceTunnelToCatalog("broker-b", {
    tunnelId: "broker-b",
    type: "instance",
    tools: ["shell"],
    agents: ["alice"],
    allowedAgents: ["alice"],
  });
  assertEquals(entries.length, 1);
  assertEquals(entries[0].card, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test src/orchestration/federation/adapters/tunnel_adapter_test.ts --filter "sets card to null"`
Expected: FAIL — currently `card` is `{}` not `null`

- [ ] **Step 3: Change `RemoteAgentCatalogEntry.card` type**

In `src/orchestration/federation/types.ts`:

```typescript
import type { AgentCard } from "../../messaging/a2a/types.ts";

export interface RemoteAgentCatalogEntry {
  remoteBrokerId: string;
  agentId: string;
  card: AgentCard | null;
  capabilities: string[];
  visibility: "public" | "restricted";
}
```

- [ ] **Step 4: Update `FederationDiscoveryPort.getRemoteAgentCard` return type**

In `src/orchestration/federation/ports.ts:66-71`:

```typescript
import type { AgentCard } from "../../messaging/a2a/types.ts";

// In FederationDiscoveryPort:
  getRemoteAgentCard(
    remoteBrokerId: string,
    agentId: string,
    correlation: FederationBrokerCorrelationContext,
  ): Promise<AgentCard | null>;
```

- [ ] **Step 5: Update `tunnel_adapter.ts` to set `card: null`**

In `src/orchestration/federation/adapters/tunnel_adapter.ts`:

```typescript
import type { TunnelCapabilities } from "../../types.ts";
import type { RemoteAgentCatalogEntry } from "../types.ts";

export function mapInstanceTunnelToCatalog(
  tunnelId: string,
  capabilities: TunnelCapabilities,
): RemoteAgentCatalogEntry[] {
  if (capabilities.type !== "instance") return [];

  return (capabilities.agents ?? []).map((agentId) => ({
    remoteBrokerId: tunnelId,
    agentId,
    card: null,
    capabilities: capabilities.tools,
    visibility: capabilities.allowedAgents.includes(agentId)
      ? "public"
      : "restricted",
  }));
}
```

- [ ] **Step 6: Update `kv_adapter.ts` — return type annotation + body**

In `src/orchestration/federation/adapters/kv_adapter.ts`, update both the return type annotation on the method (line 166) and the body:

```typescript
import type { AgentCard } from "../../../messaging/a2a/types.ts";

  async getRemoteAgentCard(
    remoteBrokerId: string,
    agentId: string,
    _correlation: FederationBrokerCorrelationContext,
  ): Promise<AgentCard | null> {
    const entries = await this.listRemoteAgents(remoteBrokerId, _correlation);
    const entry = entries.find((e) => e.agentId === agentId);
    return entry?.card ?? null;
  }
```

- [ ] **Step 7: Update `kv_adapter_test.ts` fixture**

The existing test constructs `card: { name: "Agent 1" }` which is not a valid `AgentCard`. Update the fixture to use `null`:

```typescript
// In the catalog test fixture, replace:
//   card: { name: "Agent 1" },
// With:
    card: null,
```

Do this for every `RemoteAgentCatalogEntry` fixture in the file. Search for `card:` in the test file and update each one.

- [ ] **Step 8: Run deno check + all affected tests**

Run: `deno task check && deno test src/orchestration/federation/ --allow-all`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/orchestration/federation/types.ts src/orchestration/federation/ports.ts src/orchestration/federation/adapters/tunnel_adapter.ts src/orchestration/federation/adapters/kv_adapter.ts src/orchestration/federation/adapters/tunnel_adapter_test.ts src/orchestration/federation/adapters/kv_adapter_test.ts
git commit -m "refactor(federation): type RemoteAgentCatalogEntry.card as AgentCard | null"
```

---

### Task 2: Propagate AgentCards through federation_catalog_sync

**Files:**
- Modify: `src/orchestration/types.ts:116-120`
- Modify: `src/orchestration/broker/federation_control_handlers.ts:99-136`
- Test: `src/orchestration/broker/federation_control_handlers_test.ts` (new test + update existing assertion)

- [ ] **Step 1: Update existing test assertion for new error message**

In `src/orchestration/broker/federation_control_handlers_test.ts`, the existing test at ~line 79 asserts `"agents must be a string[]"`. Update this assertion to `"agents must be an array"` since the handler will now accept both strings and objects.

- [ ] **Step 2: Write the new test for card propagation**

In `src/orchestration/broker/federation_control_handlers_test.ts`, add:

```typescript
Deno.test("federation_catalog_sync propagates agent cards", async () => {
  const receivedEntries: RemoteAgentCatalogEntry[] = [];
  const deps = createTestDeps({
    syncCatalog: (_remoteBrokerId, entries) => {
      receivedEntries.push(...entries);
      return Promise.resolve();
    },
  });
  const handlers = createBrokerFederationControlHandlers(deps);

  const card: AgentCard = {
    name: "alice",
    description: "test agent",
    version: "1.0.0",
    protocolVersion: "1.0",
    url: "https://example.com/agents/alice/task",
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };

  await handlers.federation_catalog_sync(
    createEnvelope("federation_catalog_sync", {
      remoteBrokerId: "broker-remote",
      agents: [{ agentId: "alice", card }],
      traceId: "trace-1",
    }),
  );

  assertEquals(receivedEntries.length, 1);
  assertEquals(receivedEntries[0].card?.name, "alice");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno test src/orchestration/broker/federation_control_handlers_test.ts --filter "propagates agent cards"`
Expected: FAIL — current handler expects `agents: string[]`, not structured entries

- [ ] **Step 4: Update `FederationCatalogSyncPayload` to accept structured entries**

In `src/orchestration/types.ts`:

```typescript
import type { AgentCard } from "../messaging/a2a/types.ts";

export interface FederationCatalogSyncAgentEntry {
  agentId: string;
  card?: AgentCard;
}

export interface FederationCatalogSyncPayload {
  remoteBrokerId: string;
  /** Accepts both legacy string[] and new structured entries. */
  agents: (string | FederationCatalogSyncAgentEntry)[];
  traceId: string;
}
```

- [ ] **Step 5: Update federation_control_handlers to parse both formats**

In `src/orchestration/broker/federation_control_handlers.ts`, update `federation_catalog_sync`:

```typescript
    federation_catalog_sync: async (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      const remoteBrokerId = requireNonEmptyString(
        payload.remoteBrokerId,
        "remoteBrokerId",
        envelope.type,
      );
      const traceId = requireNonEmptyString(
        payload.traceId,
        "traceId",
        envelope.type,
      );
      const rawAgents = Array.isArray(payload.agents) ? payload.agents : null;
      if (!rawAgents) {
        throw new Error(
          `Invalid ${envelope.type} payload: agents must be an array`,
        );
      }

      const entries = rawAgents.map((agent) => {
        if (typeof agent === "string") {
          return {
            remoteBrokerId,
            agentId: agent,
            card: null,
            capabilities: [],
            visibility: "public" as const,
          };
        }
        if (
          typeof agent === "object" && agent !== null &&
          typeof (agent as Record<string, unknown>).agentId === "string"
        ) {
          const entry = agent as { agentId: string; card?: AgentCard };
          return {
            remoteBrokerId,
            agentId: entry.agentId,
            card: entry.card ?? null,
            capabilities: [],
            visibility: "public" as const,
          };
        }
        throw new Error(
          `Invalid ${envelope.type} payload: each agent must be a string or { agentId, card? }`,
        );
      });

      const service = await deps.getFederationService();
      await service.syncCatalog(remoteBrokerId, entries, {
        remoteBrokerId,
        traceId,
      });
    },
```

- [ ] **Step 6: Search for other call sites constructing `FederationCatalogSyncPayload`**

Run: `deno task check` to find all type errors from the payload change. Also grep for `federation_catalog_sync` in test files and `types_test.ts` — update any fixtures that construct this payload with `agents: string[]` to match the new union type.

- [ ] **Step 7: Run tests + check**

Run: `deno task check && deno test src/orchestration/broker/federation_control_handlers_test.ts --allow-all`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/orchestration/types.ts src/orchestration/broker/federation_control_handlers.ts src/orchestration/broker/federation_control_handlers_test.ts
git commit -m "feat(federation): propagate AgentCards through catalog_sync"
```

---

### Task 3: SEC-19 — Verify broker identity before catalog sync from instance tunnels

**Files:**
- Modify: `src/orchestration/broker/tunnel_upgrade.ts:138-147`
- Test: `src/orchestration/broker/tunnel_upgrade_test.ts` (or create if not present)

**Context:** Currently `tunnel_upgrade.ts:138-147` calls `service.syncCatalog()` directly when an instance tunnel registers. This bypasses the ECDSA signature verification path (`service.syncSignedCatalog()`). A compromised tunnel could inject arbitrary catalog entries. The fix: verify the remote broker has a `trusted` identity in the identity store before accepting the catalog.

- [ ] **Step 1: Write the failing test**

Create or extend a test that verifies catalog sync is rejected when the tunnel's broker identity is not trusted:

```typescript
Deno.test("instance tunnel catalog sync rejects untrusted broker identity", async () => {
  const ctx = createTestTunnelContext({
    getIdentity: (_brokerId) => Promise.resolve(null),
  });

  // Simulate instance tunnel registration
  const result = await attemptTunnelCatalogSync(ctx, "untrusted-broker", {
    tunnelId: "untrusted-broker",
    type: "instance",
    tools: [],
    agents: ["evil-agent"],
    allowedAgents: ["evil-agent"],
  });

  assertEquals(result.synced, false);
  assertEquals(result.reason, "broker_identity_not_trusted");
});

Deno.test("instance tunnel catalog sync accepts trusted broker identity", async () => {
  const syncedEntries: RemoteAgentCatalogEntry[] = [];
  const ctx = createTestTunnelContext({
    getIdentity: (_brokerId) =>
      Promise.resolve({
        brokerId: "trusted-broker",
        instanceUrl: "https://remote.example.com",
        publicKeys: ["key1"],
        status: "trusted" as const,
      }),
    syncCatalog: (_id, entries) => {
      syncedEntries.push(...entries);
      return Promise.resolve();
    },
  });

  const result = await attemptTunnelCatalogSync(ctx, "trusted-broker", {
    tunnelId: "trusted-broker",
    type: "instance",
    tools: [],
    agents: ["alice"],
    allowedAgents: ["alice"],
  });

  assertEquals(result.synced, true);
  assertEquals(syncedEntries.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test src/orchestration/broker/tunnel_upgrade_test.ts --filter "untrusted broker"`
Expected: FAIL — current code always calls `syncCatalog()` without checking identity

- [ ] **Step 3: Add identity check before catalog sync in tunnel_upgrade.ts**

In `src/orchestration/broker/tunnel_upgrade.ts`, replace the direct `syncCatalog` call (lines 138-147):

```typescript
        if (caps.type === "instance") {
          const service = await ctx.getFederationService();
          const identity = await service.getIdentity(tunnelId);
          if (!identity || identity.status !== "trusted") {
            log.warn(
              `Tunnel ${tunnelId}: catalog sync rejected — broker identity not trusted (status: ${identity?.status ?? "unknown"})`,
            );
          } else {
            await service.syncCatalog(
              tunnelId,
              mapInstanceTunnelToCatalog(tunnelId, caps),
              {
                remoteBrokerId: tunnelId,
                traceId: crypto.randomUUID(),
              },
            );
          }
        }
```

- [ ] **Step 4: Run tests**

Run: `deno test src/orchestration/broker/ --allow-all`
Expected: PASS

- [ ] **Step 5: Run type check**

Run: `deno task check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/broker/tunnel_upgrade.ts src/orchestration/broker/tunnel_upgrade_test.ts
git commit -m "fix(sec-19): verify broker identity before accepting tunnel catalog sync"
```

---

### Task 4: Align peer messaging to return A2A Task metadata

**Files:**
- Modify: `src/agent/worker_protocol.ts`
- Modify: `src/agent/worker_pool_peer_router.ts`
- Modify: `src/agent/worker_runtime_peer_messenger.ts`
- Modify: `src/agent/tools/send_to_agent.ts` (update `SendToAgentFn` type + `execute()`)
- Modify: `src/agent/loop.ts` (update `AgentLoopDeps.sendToAgent` field type)
- Test: `src/agent/worker_pool_peer_router_test.ts` (update existing assertion)
- Test: `src/agent/worker_runtime_peer_messenger_test.ts`

- [ ] **Step 1: Write the failing test**

In `src/agent/worker_runtime_peer_messenger_test.ts`, add:

```typescript
Deno.test("sendToAgent resolves with structured PeerResult", async () => {
  const responses: WorkerResponse[] = [];
  const events = createNoopEvents();
  const messenger = new WorkerPeerMessenger(
    (msg) => responses.push(msg),
    events,
    () => "agent-a",
  );

  const sendToAgent = messenger.createSendToAgent("task-1", "ctx-1", "trace-1");
  const resultPromise = sendToAgent("agent-b", "hello");

  const sentMsg = responses[0] as WorkerPeerSendMessage;

  messenger.handlePeerResponse({
    type: "peer_response",
    requestId: sentMsg.requestId,
    content: "world",
    taskId: "peer-task-1",
    error: false,
  });

  const result = await resultPromise;
  assertEquals(result.content, "world");
  assertEquals(result.taskId, "peer-task-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test src/agent/worker_runtime_peer_messenger_test.ts --filter "structured PeerResult"`
Expected: FAIL — `sendToAgent` currently returns `string`

- [ ] **Step 3: Define PeerResult type and update peer_response in worker_protocol.ts**

In `src/agent/worker_protocol.ts`, add:

```typescript
export interface PeerResult {
  content: string;
  taskId?: string;
}
```

Update `peer_response` in `WorkerRequest` to include optional `taskId`:

```typescript
  | {
    type: "peer_response";
    requestId: string;
    content: string;
    taskId?: string;
    error?: boolean;
  }
```

- [ ] **Step 4: Update WorkerPeerMessenger to return PeerResult**

In `src/agent/worker_runtime_peer_messenger.ts`:

```typescript
import type { PeerResult, WorkerRequest, WorkerResponse } from "./worker_protocol.ts";

// Change pending map:
private agentPending = new Map<string, {
  resolve: (result: PeerResult) => void;
  reject: (err: Error) => void;
  timer: number;
}>();

// Change createSendToAgent return type:
  createSendToAgent(
    taskId?: string,
    contextId?: string,
    traceId?: string,
  ): (toAgent: string, message: string) => Promise<PeerResult> {

// Change handlePeerResponse resolve call:
    pending.resolve({ content: msg.content, taskId: msg.taskId });
```

- [ ] **Step 5: Update WorkerPoolPeerRouter to pass taskId in response**

In `src/agent/worker_pool_peer_router.ts`, update `handlePeerResult`:

```typescript
    const response: WorkerPeerResponseRequest = {
      type: "peer_response",
      requestId: pendingReq.sourceRequestId,
      content: msg.content,
      taskId: pendingReq.taskId,
      error: msg.error,
    };
```

- [ ] **Step 6: Update existing WorkerPoolPeerRouter test assertion**

In `src/agent/worker_pool_peer_router_test.ts`, the existing test asserts the exact shape of `peer_response` without `taskId`. Update to include `taskId`:

```typescript
// Update the expected peer_response message to include taskId from the pending request
assertEquals(source.messages, [{
  type: "peer_response",
  requestId: "req-source",
  content: "peer ok",
  taskId: undefined,  // add this — comes from AgentMessagePending.taskId
  error: undefined,
}]);
```

- [ ] **Step 7: Update `SendToAgentFn` type and `SendToAgentTool.execute()`**

In `src/agent/tools/send_to_agent.ts`, update the type alias:

```typescript
import type { PeerResult } from "../worker_protocol.ts";

export type SendToAgentFn = (
  toAgent: string,
  message: string,
) => Promise<PeerResult>;
```

Update `execute()` to use `result.content`:

```typescript
    const result = await this.sendFn(agentId, message);
    return this.ok(result.content);
```

- [ ] **Step 8: Update `AgentLoopDeps.sendToAgent` in loop.ts**

In `src/agent/loop.ts`, update the field type to match the new `SendToAgentFn`. Run `deno task check` to find the exact line and verify consistency.

- [ ] **Step 9: Run all affected tests**

Run: `deno test src/agent/worker_pool_peer_router_test.ts src/agent/worker_runtime_peer_messenger_test.ts --allow-all`
Expected: PASS

- [ ] **Step 10: Run full deno check**

Run: `deno task check`
Expected: PASS — no remaining type errors from the `string` → `PeerResult` change

- [ ] **Step 11: Commit**

```bash
git add src/agent/worker_protocol.ts src/agent/worker_pool_peer_router.ts src/agent/worker_runtime_peer_messenger.ts src/agent/tools/send_to_agent.ts src/agent/loop.ts src/agent/worker_pool_peer_router_test.ts src/agent/worker_runtime_peer_messenger_test.ts
git commit -m "refactor(peer): align peer messaging to return structured PeerResult with taskId"
```

---

### Task 5: Fix SSE spec compliance — remove custom `{ kind: "task" }` frame

**Files:**
- Modify: `src/messaging/a2a/server.ts:203`
- Test: Create `src/messaging/a2a/server_sse_test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/messaging/a2a/server_sse_test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import { A2AServer } from "./server.ts";
import type { AgentCard } from "./types.ts";

const testCard: AgentCard = {
  name: "test",
  description: "test agent",
  version: "1.0.0",
  protocolVersion: "1.0",
  url: "http://localhost:9999/a2a",
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
};

Deno.test("message/stream first event is taskStatusUpdate SUBMITTED, not custom task frame", async () => {
  const server = new A2AServer(testCard, async (task, _msg) => {
    await server.completeTask(task.id, "done");
  });

  const req = new Request("http://localhost:9999/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/stream",
      params: {
        message: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
        },
      },
    }),
  });

  const res = await server.handleRequest(req);
  const text = await res!.text();
  const frames = text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));

  const firstResult = frames[0].result;
  assertEquals(firstResult.kind, "taskStatusUpdate");
  assertEquals(firstResult.status.state, "SUBMITTED");

  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test src/messaging/a2a/server_sse_test.ts --allow-all`
Expected: FAIL — first frame has `kind: "task"`

- [ ] **Step 3: Replace the custom task frame with a SUBMITTED status event**

In `src/messaging/a2a/server.ts`, replace line 203:

```typescript
        // was: this.sseEvent(controller, encoder, rpc.id, { kind: "task", ...task });
        this.sseEvent(controller, encoder, rpc.id, {
          kind: "taskStatusUpdate",
          taskId: task.id,
          status: task.status,
          final: false,
        } as TaskStatusUpdateEvent);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/messaging/a2a/server_sse_test.ts --allow-all`
Expected: PASS

- [ ] **Step 5: Run all A2A tests**

Run: `deno test src/messaging/a2a/ --allow-all`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/messaging/a2a/server.ts src/messaging/a2a/server_sse_test.ts
git commit -m "fix(a2a): replace custom SSE task frame with spec-compliant taskStatusUpdate SUBMITTED"
```

---

### Task 6: Clean up deprecated `message` aliases

**Files:**
- Modify: `src/messaging/a2a/internal_contract.ts:34-46,48-58`
- Modify: `src/orchestration/types.ts:54-69,81-97`
- Delete test: `src/messaging/a2a/internal_contract_test.ts` (~line 47-55, the legacy alias compat test)
- Test: Run existing tests to verify no breakage

- [ ] **Step 1: Search for all usages of deprecated aliases**

Grep for call sites using `message:` on these interfaces:
- `CanonicalTaskInit` → look for `{ ..., message: ... }` vs `{ ..., initialMessage: ... }`
- `TaskTransitionOptions` → look for `{ ..., message: ... }` vs `{ ..., statusMessage: ... }`
- `BrokerTaskSubmitPayload` → look for `{ ..., message: ... }` vs `{ ..., taskMessage: ... }`
- `BrokerTaskContinuePayload` → look for `{ ..., message: ... }` vs `{ ..., continuationMessage: ... }`

Run: `grep -rn '{ .*message:' src/ --include='*.ts' | grep -v 'taskMessage\|statusMessage\|initialMessage\|continuationMessage\|channelMessage\|errorMessage\|A2AMessage\|BrokerMessage'`

- [ ] **Step 2: Update all call sites to use canonical names**

For each call site found:
- `{ message: ... }` on `CanonicalTaskInit` → `{ initialMessage: ... }`
- `{ message: ... }` on `TaskTransitionOptions` → `{ statusMessage: ... }`
- `{ message: ... }` on `BrokerTaskSubmitPayload` → `{ taskMessage: ... }`
- `{ message: ... }` on `BrokerTaskContinuePayload` → `{ continuationMessage: ... }`

- [ ] **Step 3: Delete the legacy alias compatibility test**

In `src/messaging/a2a/internal_contract_test.ts`, delete the test named `"createCanonicalTask preserves legacy message alias for compatibility"` (~lines 47-55). This test explicitly verifies the deprecated alias — it must be removed.

- [ ] **Step 4: Remove deprecated aliases from CanonicalTaskInit**

In `src/messaging/a2a/internal_contract.ts`:

```typescript
export interface CanonicalTaskInit {
  initialMessage: A2AMessage;
  id: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}
```

Update `createCanonicalTask`:

```typescript
export function createCanonicalTask(init: CanonicalTaskInit): Task {
  return {
    id: init.id,
    contextId: resolveTaskContextId(init.id, init.contextId),
    status: {
      state: "SUBMITTED",
      timestamp: init.timestamp ?? new Date().toISOString(),
    },
    artifacts: [],
    history: [init.initialMessage],
    metadata: init.metadata,
  };
}
```

- [ ] **Step 5: Remove deprecated aliases from TaskTransitionOptions**

```typescript
export interface TaskTransitionOptions {
  statusMessage?: A2AMessage;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}
```

Update `transitionTask`:

```typescript
export function transitionTask(
  task: Task,
  state: TaskState,
  options: TaskTransitionOptions = {},
): Task {
  assertValidTaskTransition(task.status.state, state);
  return {
    ...task,
    status: {
      state,
      timestamp: options.timestamp ?? new Date().toISOString(),
      ...(options.statusMessage ? { message: options.statusMessage } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
  };
}
```

- [ ] **Step 6: Remove deprecated aliases from BrokerTaskSubmitPayload and BrokerTaskContinuePayload**

In `src/orchestration/types.ts`:

```typescript
export interface BrokerTaskSubmitPayload {
  targetAgent: string;
  taskId: string;
  taskMessage: A2AMessage;
  contextId?: string;
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
}

export interface BrokerTaskContinuePayload {
  taskId: string;
  continuationMessage: A2AMessage;
  metadata?: Record<string, unknown>;
}
```

Remove fallback logic from extractors:

```typescript
export function extractBrokerSubmitTaskMessage(
  payload: BrokerTaskSubmitPayload,
): A2AMessage {
  return payload.taskMessage;
}

export function extractBrokerContinuationMessage(
  payload: BrokerTaskContinuePayload,
): A2AMessage {
  return payload.continuationMessage;
}
```

- [ ] **Step 7: Run type check and fix any remaining references**

Run: `deno task check`
Fix any remaining call sites that still use the old `message` property.

- [ ] **Step 8: Run full test suite**

Run: `deno task test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/messaging/a2a/internal_contract.ts src/messaging/a2a/internal_contract_test.ts src/orchestration/types.ts
git commit -m "refactor(a2a): remove deprecated message aliases from task contracts"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `deno task test`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `deno task lint`
Expected: PASS

- [ ] **Step 3: Run type check**

Run: `deno task check`
Expected: PASS

- [ ] **Step 4: Run E2E tests**

Run: `deno task test:e2e`
Expected: PASS

- [ ] **Step 5: Commit any final fixes**

```bash
git commit -m "chore: final verification pass for federation A2A consolidation"
```
