import { assertEquals } from "@std/assert";
import { AgentLoop } from "./loop.ts";
import { ToolRegistry } from "./tools/registry.ts";
import type {
  SandboxPermission,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";
import { BaseTool } from "./tools/registry.ts";

// Minimal AgentLoopConfig with no providers configured — enough to construct a loop
const minimalConfig = {
  agents: {
    defaults: {
      model: "test/model",
      temperature: 0.5,
      maxTokens: 512,
    },
  },
  providers: {},
  tools: {},
};

class StubTool extends BaseTool {
  name = "stub";
  description = "A stub tool for testing";
  permissions: SandboxPermission[] = [];

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
    return Promise.resolve(this.ok("stub result"));
  }
}

Deno.test({
  name:
    "AgentLoop accepts custom tools via AgentLoopDeps — auto-registration skipped",
  fn() {
    const registry = new ToolRegistry();
    registry.register(new StubTool());

    const loop = new AgentLoop("test-session", minimalConfig, {}, 10, {
      tools: registry,
    });

    const tools = loop.getTools();
    // Our injected stub + memory tool (always registered)
    assertEquals(tools.size, 2);
    const defs = tools.getDefinitions();
    assertEquals(defs.length, 2);
    const names = defs.map((d) => d.function.name).sort();
    assertEquals(names, ["memory", "stub"]);

    loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentLoop registers built-in tools by default (no deps)",
  fn() {
    const loop = new AgentLoop("test-session-defaults", minimalConfig);

    const tools = loop.getTools();
    // 4 built-in tools + memory tool
    assertEquals(tools.size, 5);

    const names = tools.getDefinitions().map((d) => d.function.name).sort();
    assertEquals(names, [
      "memory",
      "read_file",
      "shell",
      "web_fetch",
      "write_file",
    ]);

    loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentLoop close() does not throw",
  fn() {
    const loop = new AgentLoop("test-session-close", minimalConfig);
    // close() should not throw even if KV was never opened
    loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
