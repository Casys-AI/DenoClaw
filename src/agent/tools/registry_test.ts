import { assertEquals } from "@std/assert";
import type { ToolDefinition, ToolResult } from "../../shared/mod.ts";
import { BaseTool, ToolRegistry } from "./registry.ts";

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
