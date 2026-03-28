import {
  createAwaitedInputMetadata,
  createResumePayloadMetadata,
  getAwaitedInputMetadata,
  getResumePayloadMetadata,
} from "./input_metadata.ts";
import { assertEquals } from "@std/assert";
import type { TaskStatus } from "./types.ts";

Deno.test("createAwaitedInputMetadata supports approval requests", () => {
  const metadata = createAwaitedInputMetadata({
    kind: "approval",
    command: "git status",
    binary: "git",
    prompt: "Allow once?",
    continuationToken: "cont-1",
  });

  assertEquals(getAwaitedInputMetadata({ metadata }), {
    kind: "approval",
    command: "git status",
    binary: "git",
    prompt: "Allow once?",
    continuationToken: "cont-1",
  });
});

Deno.test("createAwaitedInputMetadata supports clarification requests", () => {
  const metadata = createAwaitedInputMetadata({
    kind: "clarification",
    question: "Which repo should I target?",
    fields: [{ key: "repo", label: "Repository", required: true }],
    continuationToken: "cont-2",
  });

  assertEquals(getAwaitedInputMetadata({ metadata }), {
    kind: "clarification",
    question: "Which repo should I target?",
    fields: [{ key: "repo", label: "Repository", required: true }],
    continuationToken: "cont-2",
  });
});

Deno.test("createAwaitedInputMetadata supports confirmation requests", () => {
  const metadata = createAwaitedInputMetadata({
    kind: "confirmation",
    prompt: "Delete the draft schedule?",
    continuationToken: "cont-3",
    destructive: true,
  });

  assertEquals(getAwaitedInputMetadata({ metadata }), {
    kind: "confirmation",
    prompt: "Delete the draft schedule?",
    continuationToken: "cont-3",
    destructive: true,
  });
});

Deno.test("createResumePayloadMetadata preserves resume payload shape", () => {
  const metadata = createResumePayloadMetadata({
    continuationToken: "cont-4",
    kind: "approval",
    approved: true,
    responseText: "allow-once",
    fields: { scope: "current-command" },
  });

  assertEquals(getResumePayloadMetadata({ metadata }), {
    continuationToken: "cont-4",
    kind: "approval",
    approved: true,
    responseText: "allow-once",
    fields: { scope: "current-command" },
  });
});

Deno.test("awaited input metadata composes with TaskStatus.message and metadata", () => {
  const status: TaskStatus = {
    state: "INPUT_REQUIRED",
    timestamp: "2026-03-28T00:00:00.000Z",
    message: {
      messageId: "msg-1",
      role: "agent",
      parts: [{ kind: "text", text: "Need approval" }],
    },
    metadata: createAwaitedInputMetadata({
      kind: "approval",
      command: "git status",
      binary: "git",
      continuationToken: "cont-5",
    }),
  };

  assertEquals(status.message?.parts[0], { kind: "text", text: "Need approval" });
  assertEquals(getAwaitedInputMetadata(status), {
    kind: "approval",
    command: "git status",
    binary: "git",
    continuationToken: "cont-5",
  });
});
