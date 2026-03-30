import { assertEquals } from "@std/assert";
import type { A2AMessage } from "../messaging/a2a/types.ts";
import {
  extractRuntimeApprovalPause,
  extractRuntimeTaskText,
} from "./runtime_message_mapping.ts";

Deno.test("extractRuntimeTaskText joins text parts and trims whitespace", () => {
  const message: A2AMessage = {
    messageId: "msg-1",
    role: "user",
    parts: [
      { kind: "text", text: " hello " },
      {
        kind: "file",
        name: "note.txt",
        mimeType: "text/plain",
        data: "Zm9v",
      },
      { kind: "text", text: "world " },
    ],
  };

  assertEquals(extractRuntimeTaskText(message), "hello \nworld");
});

Deno.test("extractRuntimeTaskText falls back for non-text payloads", () => {
  const message: A2AMessage = {
    messageId: "msg-2",
    role: "user",
    parts: [{ kind: "data", data: { answer: 42 } }],
  };

  assertEquals(extractRuntimeTaskText(message), "[non-text task payload]");
});

Deno.test("extractRuntimeApprovalPause maps approval-required tool results", () => {
  const pause = extractRuntimeApprovalPause({
    success: false,
    output: "",
    error: {
      code: "EXEC_APPROVAL_REQUIRED",
      context: {
        command: "git status",
        binary: "git",
        reason: "always-ask",
      },
      recovery: "Resume with approval",
    },
  });

  assertEquals(pause, {
    command: "git status",
    binary: "git",
    reason: "always-ask",
    prompt: "Awaiting approval for git: git status",
  });
});

Deno.test("extractRuntimeApprovalPause ignores unrelated tool failures", () => {
  const pause = extractRuntimeApprovalPause({
    success: false,
    output: "",
    error: {
      code: "EXEC_FAILED",
      context: { command: "git status", binary: "git", reason: "always-ask" },
      recovery: "Retry",
    },
  });

  assertEquals(pause, null);
});
