import { assertEquals } from "@std/assert";
import type { A2AMessage } from "../messaging/a2a/types.ts";
import {
  extractApprovedPrivilegeElevationGrant,
  extractRuntimePrivilegeElevationPause,
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

Deno.test("extractRuntimePrivilegeElevationPause maps privilege elevation-required tool results", () => {
  const pause = extractRuntimePrivilegeElevationPause({
    success: false,
    output: "",
    error: {
      code: "PRIVILEGE_ELEVATION_REQUIRED",
      context: {
        command: "write_file",
        binary: "write_file",
        elevationAvailable: true,
        suggestedGrants: [{ permission: "write", paths: ["note.txt"] }],
      },
      recovery: "Temporarily grant write access to continue",
    },
  });

  assertEquals(pause, {
    grants: [{ permission: "write", paths: ["note.txt"] }],
    scope: "task",
    command: "write_file",
    binary: "write_file",
    expiresAt: undefined,
    prompt: "Temporarily grant write access to continue",
  });
});

Deno.test("extractRuntimePrivilegeElevationPause builds a readable fallback prompt", () => {
  const pause = extractRuntimePrivilegeElevationPause({
    success: false,
    output: "",
    error: {
      code: "PRIVILEGE_ELEVATION_REQUIRED",
      context: {
        tool: "write_file",
        elevationAvailable: true,
        suggestedGrants: [{ permission: "write", paths: ["note.txt"] }],
      },
    },
  });

  assertEquals(pause, {
    grants: [{ permission: "write", paths: ["note.txt"] }],
    scope: "task",
    command: undefined,
    binary: undefined,
    expiresAt: undefined,
    prompt:
      "Temporary privilege elevation required for write_file (this task): write paths=[note.txt]",
  });
});

Deno.test("extractRuntimePrivilegeElevationPause computes an expiration when the broker advertises a timeout", () => {
  const before = Date.now();
  const pause = extractRuntimePrivilegeElevationPause({
    success: false,
    output: "",
    error: {
      code: "PRIVILEGE_ELEVATION_REQUIRED",
      context: {
        tool: "write_file",
        elevationAvailable: true,
        privilegeElevationRequestTimeoutSec: 60,
        suggestedGrants: [{ permission: "write", paths: ["note.txt"] }],
      },
    },
  });
  const after = Date.now();

  assertEquals(pause?.scope, "task");
  const expiresAtMs = pause?.expiresAt ? Date.parse(pause.expiresAt) : NaN;
  assertEquals(
    Number.isFinite(expiresAtMs) && expiresAtMs >= before + 59_000 &&
      expiresAtMs <= after + 61_000,
    true,
  );
});

Deno.test("extractRuntimePrivilegeElevationPause prefers session scope when advertised by the broker", () => {
  const pause = extractRuntimePrivilegeElevationPause({
    success: false,
    output: "",
    error: {
      code: "PRIVILEGE_ELEVATION_REQUIRED",
      context: {
        tool: "write_file",
        elevationAvailable: true,
        privilegeElevationScopes: ["once", "task", "session"],
        suggestedGrants: [{ permission: "write", paths: ["note.txt"] }],
      },
    },
  });

  assertEquals(pause?.scope, "session");
  assertEquals(
    pause?.prompt,
    "Temporary privilege elevation required for write_file (this session): write paths=[note.txt]",
  );
});

Deno.test("extractRuntimePrivilegeElevationPause stays non-resumable when privilege elevation is disabled", () => {
  const pause = extractRuntimePrivilegeElevationPause({
    success: false,
    output: "",
    error: {
      code: "PRIVILEGE_ELEVATION_REQUIRED",
      context: {
        tool: "write_file",
        privilegeElevationSupported: false,
        suggestedGrants: [{ permission: "write", paths: ["note.txt"] }],
      },
      recovery: "Update agent sandbox.allowedPermissions or broker policy",
    },
  });

  assertEquals(pause, null);
});

Deno.test("extractRuntimePrivilegeElevationPause stays non-resumable when no elevation channel is available", () => {
  const pause = extractRuntimePrivilegeElevationPause({
    success: false,
    output: "",
    error: {
      code: "PRIVILEGE_ELEVATION_REQUIRED",
      context: {
        tool: "write_file",
        privilegeElevationSupported: true,
        elevationAvailable: false,
        elevationReason: "no_channel",
        suggestedGrants: [{ permission: "write", paths: ["note.txt"] }],
      },
      recovery: "Attach an elevation channel or update policy",
    },
  });

  assertEquals(pause, null);
});

Deno.test("extractApprovedPrivilegeElevationGrant rebuilds a runtime grant from broker resume payload", () => {
  const grant = extractApprovedPrivilegeElevationGrant(
    {
      status: {
        metadata: {
          awaitedInput: {
            kind: "privilege-elevation",
            grants: [{ permission: "write", paths: ["note.txt"] }],
            scope: "task",
            prompt: "Need write access",
          },
        },
      },
    },
    {
      metadata: {
        resume: {
          kind: "privilege-elevation",
          approved: true,
          grants: [{ permission: "write", paths: ["note.txt"] }],
          scope: "task",
        },
      },
    },
  );

  assertEquals(grant?.kind, "privilege-elevation");
  assertEquals(grant?.scope, "task");
  assertEquals(grant?.grants, [{ permission: "write", paths: ["note.txt"] }]);
  assertEquals(grant?.source, "broker-resume");
});
