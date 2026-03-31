import { assertEquals } from "@std/assert";
import {
  isExecutionRequest,
  isExecutionResponse,
  isInfraRequest,
  isInfraResponse,
} from "./worker_protocol.ts";

// ── Infra classification ─────────────────────────────────

Deno.test("worker protocol classifies init and shutdown as infra requests", () => {
  assertEquals(isInfraRequest("init"), true);
  assertEquals(isInfraRequest("shutdown"), true);
});

Deno.test("worker protocol classifies ready, task_started, task_completed as infra responses", () => {
  assertEquals(isInfraResponse("ready"), true);
  assertEquals(isInfraResponse("task_started"), true);
  assertEquals(isInfraResponse("task_completed"), true);
});

// ── Execution classification ─────────────────────────────

Deno.test("worker protocol classifies run, peer_deliver, peer_response as execution requests", () => {
  assertEquals(isExecutionRequest("run"), true);
  assertEquals(isExecutionRequest("peer_deliver"), true);
  assertEquals(isExecutionRequest("peer_response"), true);
});

Deno.test("worker protocol classifies run_result, run_error, peer_send, peer_result, task_observe as execution responses", () => {
  assertEquals(isExecutionResponse("run_result"), true);
  assertEquals(isExecutionResponse("run_error"), true);
  assertEquals(isExecutionResponse("peer_send"), true);
  assertEquals(isExecutionResponse("peer_result"), true);
  assertEquals(isExecutionResponse("task_observe"), true);
});

// ── Mutual exclusion ─────────────────────────────────────

Deno.test("worker protocol infra and execution classifications are mutually exclusive for requests", () => {
  for (const type of ["init", "shutdown"] as const) {
    assertEquals(isInfraRequest(type), true);
    assertEquals(isExecutionRequest(type), false);
  }
  for (const type of ["run", "peer_deliver", "peer_response"] as const) {
    assertEquals(isInfraRequest(type), false);
    assertEquals(isExecutionRequest(type), true);
  }
});

Deno.test("worker protocol infra and execution classifications are mutually exclusive for responses", () => {
  for (const type of ["ready", "task_started", "task_completed"] as const) {
    assertEquals(isInfraResponse(type), true);
    assertEquals(isExecutionResponse(type), false);
  }
  for (
    const type of [
      "run_result",
      "run_error",
      "peer_send",
      "peer_result",
      "task_observe",
    ] as const
  ) {
    assertEquals(isInfraResponse(type), false);
    assertEquals(isExecutionResponse(type), true);
  }
});

// ── WorkerPool still works with the reclassified protocol ──

Deno.test("worker pool imports from reclassified worker_protocol without type errors", async () => {
  // Dynamic import verifies that worker_pool.ts still resolves
  // against the reclassified protocol types without breaking.
  const mod = await import("./worker_pool.ts");
  assertEquals(typeof mod.WorkerPool, "function");
});
