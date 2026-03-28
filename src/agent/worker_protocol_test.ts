import { assertEquals } from "@std/assert";
import {
  isInfraRequest,
  isInfraResponse,
  isBridgeRequest,
  isBridgeResponse,
} from "./worker_protocol.ts";

// ── Infra classification ─────────────────────────────────

Deno.test("worker protocol classifies init, ask_response, shutdown as infra requests", () => {
  assertEquals(isInfraRequest("init"), true);
  assertEquals(isInfraRequest("ask_response"), true);
  assertEquals(isInfraRequest("shutdown"), true);
});

Deno.test("worker protocol classifies ready, ask_approval, task_started, task_completed as infra responses", () => {
  assertEquals(isInfraResponse("ready"), true);
  assertEquals(isInfraResponse("ask_approval"), true);
  assertEquals(isInfraResponse("task_started"), true);
  assertEquals(isInfraResponse("task_completed"), true);
});

// ── Bridge classification ────────────────────────────────

Deno.test("worker protocol classifies process, agent_deliver, agent_response as bridge requests", () => {
  assertEquals(isBridgeRequest("process"), true);
  assertEquals(isBridgeRequest("agent_deliver"), true);
  assertEquals(isBridgeRequest("agent_response"), true);
});

Deno.test("worker protocol classifies result, error, agent_send, agent_result, agent_task as bridge responses", () => {
  assertEquals(isBridgeResponse("result"), true);
  assertEquals(isBridgeResponse("error"), true);
  assertEquals(isBridgeResponse("agent_send"), true);
  assertEquals(isBridgeResponse("agent_result"), true);
  assertEquals(isBridgeResponse("agent_task"), true);
});

// ── Mutual exclusion ─────────────────────────────────────

Deno.test("worker protocol infra and bridge classifications are mutually exclusive for requests", () => {
  for (const type of ["init", "ask_response", "shutdown"]) {
    assertEquals(isInfraRequest(type), true);
    assertEquals(isBridgeRequest(type), false);
  }
  for (const type of ["process", "agent_deliver", "agent_response"]) {
    assertEquals(isInfraRequest(type), false);
    assertEquals(isBridgeRequest(type), true);
  }
});

Deno.test("worker protocol infra and bridge classifications are mutually exclusive for responses", () => {
  for (const type of ["ready", "ask_approval", "task_started", "task_completed"]) {
    assertEquals(isInfraResponse(type), true);
    assertEquals(isBridgeResponse(type), false);
  }
  for (const type of ["result", "error", "agent_send", "agent_result", "agent_task"]) {
    assertEquals(isInfraResponse(type), false);
    assertEquals(isBridgeResponse(type), true);
  }
});

// ── WorkerPool still works with the reclassified protocol ──

Deno.test("worker pool imports from reclassified worker_protocol without type errors", async () => {
  // Dynamic import verifies that worker_pool.ts still resolves
  // against the reclassified protocol types without breaking.
  const mod = await import("./worker_pool.ts");
  assertEquals(typeof mod.WorkerPool, "function");
});
