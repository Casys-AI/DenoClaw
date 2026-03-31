import { assertEquals } from "@std/assert";
import type {
  SandboxConfig,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import type { SandboxBackend } from "../sandbox_types.ts";
import { BaseTool, ToolRegistry } from "./registry.ts";
import { deriveAgentRuntimeCapabilities } from "../runtime_capabilities.ts";

class MockTool extends BaseTool {
  name = "mock";
  description = "A mock tool for testing";
  permissions = [];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
  }

  execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return Promise.resolve(this.ok("mock result"));
  }
}

class FailTool extends BaseTool {
  name = "fail";
  description = "Always fails";
  permissions = [];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
  }

  execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return Promise.resolve(
      this.fail("INTENTIONAL_FAILURE", { reason: "test" }, "This is expected"),
    );
  }
}

class PermissionedTool extends BaseTool {
  name = "write_file";
  description = "Needs write";
  permissions = ["write" as const];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
  }

  execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return Promise.resolve(this.ok("unexpected"));
  }
}

class ShellPermissionedTool extends BaseTool {
  name = "shell";
  description = "Needs run";
  permissions = ["run" as const];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
  }

  execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return Promise.resolve(this.ok("unexpected"));
  }
}

class DenyBackend implements SandboxBackend {
  readonly kind = "local" as const;

  execute(): Promise<ToolResult> {
    return Promise.resolve({
      success: false,
      output: "",
      error: {
        code: "SANDBOX_PERMISSION_DENIED",
        context: {
          denied: ["write"],
        },
      },
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class ExecDeniedBackend implements SandboxBackend {
  readonly kind = "local" as const;

  execute(): Promise<ToolResult> {
    return Promise.resolve({
      success: false,
      output: "",
      error: {
        code: "EXEC_DENIED",
        context: {
          command: "git clone https://example.com/repo.git",
          binary: "git",
          reason: "not-in-allowlist",
        },
        recovery: "Update execPolicy.allowedCommands",
      },
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("ToolRegistry registers and executes tools", async () => {
  const registry = new ToolRegistry();
  registry.register(new MockTool());
  assertEquals(registry.size, 1);

  const result = await registry.execute("mock", {});
  assertEquals(result.success, true);
  assertEquals(result.output, "mock result");
});

Deno.test("ToolRegistry returns structured error for unknown tool", async () => {
  const registry = new ToolRegistry();
  const result = await registry.execute("nonexistent", {});
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "TOOL_NOT_FOUND");
  assertEquals(result.error?.context?.tool, "nonexistent");
  assertEquals(typeof result.error?.recovery, "string");
});

Deno.test("ToolRegistry getDefinitions returns all defs", () => {
  const registry = new ToolRegistry();
  registry.register(new MockTool());
  registry.register(new FailTool());
  const defs = registry.getDefinitions();
  assertEquals(defs.length, 2);
  assertEquals(defs[0].function.name, "mock");
  assertEquals(defs[1].function.name, "fail");
});

Deno.test("FailTool returns structured error", async () => {
  const registry = new ToolRegistry();
  registry.register(new FailTool());
  const result = await registry.execute("fail", {});
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "INTENTIONAL_FAILURE");
  assertEquals(result.error?.context?.reason, "test");
  assertEquals(result.error?.recovery, "This is expected");
});

Deno.test("ToolRegistry normalizes backend permission denials to PRIVILEGE_ELEVATION_REQUIRED", async () => {
  const registry = new ToolRegistry();
  registry.register(new PermissionedTool());
  const sandboxConfig: SandboxConfig = {
    allowedPermissions: ["read"],
    execPolicy: {
      security: "allowlist",
      allowedCommands: [],
      ask: "on-miss",
      askFallback: "deny",
    },
  };
  registry.setBackend(
    new DenyBackend(),
    sandboxConfig.execPolicy,
    undefined,
    undefined,
    undefined,
    sandboxConfig,
    deriveAgentRuntimeCapabilities({ sandboxConfig }),
  );

  const result = await registry.execute("write_file", {
    path: "note.txt",
    content: "hi",
  });

  assertEquals(result.success, false);
  assertEquals(result.error?.code, "PRIVILEGE_ELEVATION_REQUIRED");
  assertEquals(result.error?.context?.tool, "write_file");
  assertEquals(result.error?.context?.requiredPermissions, ["write"]);
  assertEquals(result.error?.context?.agentAllowed, ["read"]);
  assertEquals(result.error?.context?.denied, ["write"]);
  assertEquals(result.error?.context?.backendCode, "SANDBOX_PERMISSION_DENIED");
  assertEquals(
    result.error?.recovery,
    "Update agent sandbox.allowedPermissions or broker policy to allow write_file (write paths=[note.txt])",
  );
});

Deno.test("ToolRegistry normalizes backend exec denials to EXEC_POLICY_DENIED", async () => {
  const registry = new ToolRegistry();
  registry.register(new PermissionedTool());
  const sandboxConfig: SandboxConfig = {
    allowedPermissions: ["write"],
    execPolicy: {
      security: "allowlist",
      allowedCommands: [],
      ask: "off",
      askFallback: "deny",
    },
  };
  registry.setBackend(
    new ExecDeniedBackend(),
    sandboxConfig.execPolicy,
    undefined,
    undefined,
    undefined,
    sandboxConfig,
    deriveAgentRuntimeCapabilities({ sandboxConfig }),
  );

  const result = await registry.execute("write_file", {
    path: "note.txt",
    content: "hi",
  });

  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_POLICY_DENIED");
  assertEquals(
    result.error?.context?.command,
    "git clone https://example.com/repo.git",
  );
  assertEquals(result.error?.context?.binary, "git");
  assertEquals(result.error?.context?.reason, "not-in-allowlist");
  assertEquals(result.error?.context?.backendCode, "EXEC_DENIED");
});

Deno.test("ToolRegistry includes shell command context in privilege elevation errors", async () => {
  const registry = new ToolRegistry();
  registry.register(new ShellPermissionedTool());
  const sandboxConfig: SandboxConfig = {
    allowedPermissions: [],
    execPolicy: {
      security: "allowlist",
      allowedCommands: [],
      ask: "off",
      askFallback: "deny",
    },
  };
  registry.setBackend(
    new DenyBackend(),
    sandboxConfig.execPolicy,
    undefined,
    undefined,
    undefined,
    sandboxConfig,
    deriveAgentRuntimeCapabilities({ sandboxConfig }),
  );

  const result = await registry.execute("shell", {
    command: "git status",
    dry_run: false,
  });

  assertEquals(result.success, false);
  assertEquals(result.error?.code, "PRIVILEGE_ELEVATION_REQUIRED");
  assertEquals(result.error?.context?.tool, "shell");
  assertEquals(result.error?.context?.command, "git status");
  assertEquals(result.error?.context?.binary, "git");
  assertEquals(
    result.error?.recovery,
    "Update agent sandbox.allowedPermissions or broker policy to allow git (run groups=[shell])",
  );
});
