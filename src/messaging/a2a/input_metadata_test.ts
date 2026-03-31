import {
  createAwaitedInputMetadata,
  createResumePayloadMetadata,
  getAwaitedInputMetadata,
  getResumePayloadMetadata,
} from "./input_metadata.ts";
import { assertEquals } from "@std/assert";
import type { TaskStatus } from "./types.ts";

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

Deno.test("createAwaitedInputMetadata supports privilege elevation requests", () => {
  const metadata = createAwaitedInputMetadata({
    kind: "privilege-elevation",
    grants: [
      {
        permission: "net",
        hosts: ["api.github.com"],
      },
      {
        permission: "write",
        paths: ["/workspace/repo/docs"],
      },
    ],
    scope: "task",
    command: "git clone https://github.com/example/repo",
    binary: "git",
    prompt: "Grant temporary privileges?",
    expiresAt: "2026-03-31T00:05:00.000Z",
    continuationToken: "cont-elev-1",
  });

  assertEquals(getAwaitedInputMetadata({ metadata }), {
    kind: "privilege-elevation",
    grants: [
      {
        permission: "net",
        hosts: ["api.github.com"],
      },
      {
        permission: "write",
        paths: ["/workspace/repo/docs"],
      },
    ],
    scope: "task",
    command: "git clone https://github.com/example/repo",
    binary: "git",
    prompt: "Grant temporary privileges?",
    expiresAt: "2026-03-31T00:05:00.000Z",
    continuationToken: "cont-elev-1",
  });
});

Deno.test("createResumePayloadMetadata preserves resume payload shape", () => {
  const metadata = createResumePayloadMetadata({
    continuationToken: "cont-4",
    kind: "confirmation",
    approved: true,
    responseText: "confirmed",
    fields: { acknowledgedBy: "operator" },
  });

  assertEquals(getResumePayloadMetadata({ metadata }), {
    continuationToken: "cont-4",
    kind: "confirmation",
    approved: true,
    responseText: "confirmed",
    fields: { acknowledgedBy: "operator" },
  });
});

Deno.test("createResumePayloadMetadata preserves privilege elevation payload shape", () => {
  const metadata = createResumePayloadMetadata({
    continuationToken: "cont-priv-1",
    kind: "privilege-elevation",
    approved: true,
    scope: "once",
    grants: [{
      permission: "env",
      keys: ["GITHUB_TOKEN"],
    }],
  });

  assertEquals(getResumePayloadMetadata({ metadata }), {
    continuationToken: "cont-priv-1",
    kind: "privilege-elevation",
    approved: true,
    scope: "once",
    grants: [{
      permission: "env",
      keys: ["GITHUB_TOKEN"],
    }],
  });
});

Deno.test("awaited input metadata composes with TaskStatus.message and metadata", () => {
  const status: TaskStatus = {
    state: "INPUT_REQUIRED",
    timestamp: "2026-03-28T00:00:00.000Z",
    message: {
      messageId: "msg-1",
      role: "agent",
      parts: [{ kind: "text", text: "Need temporary privileges" }],
    },
    metadata: createAwaitedInputMetadata({
      kind: "privilege-elevation",
      grants: [{ permission: "write", paths: ["note.txt"] }],
      scope: "task",
      expiresAt: "2026-03-31T00:05:00.000Z",
      continuationToken: "cont-5",
    }),
  };

  assertEquals(status.message?.parts[0], {
    kind: "text",
    text: "Need temporary privileges",
  });
  assertEquals(getAwaitedInputMetadata(status), {
    kind: "privilege-elevation",
    grants: [{ permission: "write", paths: ["note.txt"] }],
    scope: "task",
    expiresAt: "2026-03-31T00:05:00.000Z",
    continuationToken: "cont-5",
  });
});
