import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { LocalToolExecutionAdapter } from "./tool_execution_local.ts";
import {
  readWorkspaceKv,
} from "../../agent/tools/file_workspace.ts";

Deno.test({
  name:
    "LocalToolExecutionAdapter executes workspace KV file tools directly without sandbox",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const kv = await Deno.openKv(join(tmpDir, "workspace.db"));
    let sandboxCalls = 0;
    const adapter = new LocalToolExecutionAdapter({
      sandbox: {
        executeTool: () => {
          sandboxCalls++;
          return Promise.resolve({ success: true, output: "sandbox" });
        },
        close: () => Promise.resolve(),
      },
      requireSandboxForPermissionedTools: true,
      getWorkspaceKv: () => Promise.resolve(kv),
    });

    const writeResult = await adapter.executeTool({
      tool: "write_file",
      args: {
        path: "memories/cloud.md",
        content: "# Cloud",
        dry_run: false,
      },
      permissions: ["write"],
      execPolicy: { security: "deny" },
      toolsConfig: {
        agentId: "agent-cloud",
        workspaceBackend: "kv",
      },
    });
    const readResult = await adapter.executeTool({
      tool: "read_file",
      args: { path: "memories/cloud.md" },
      permissions: ["read"],
      execPolicy: { security: "deny" },
      toolsConfig: {
        agentId: "agent-cloud",
        workspaceBackend: "kv",
      },
    });

    assertEquals(writeResult.success, true);
    assertEquals(readResult.success, true);
    assertEquals(readResult.output, "# Cloud");
    assertEquals(
      await readWorkspaceKv(kv, "agent-cloud", "memories/cloud.md"),
      "# Cloud",
    );
    assertEquals(sandboxCalls, 0);

    await adapter.close();
    kv.close();
    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test("LocalToolExecutionAdapter fails fast when workspace KV is unavailable", async () => {
  const adapter = new LocalToolExecutionAdapter({
    requireSandboxForPermissionedTools: true,
  });

  const result = await adapter.executeTool({
    tool: "read_file",
    args: { path: "memories/cloud.md" },
    permissions: ["read"],
    execPolicy: { security: "deny" },
    toolsConfig: {
      agentId: "agent-cloud",
      workspaceBackend: "kv",
    },
  });

  assertEquals(result.success, false);
  assertEquals(result.error?.code, "WORKSPACE_KV_UNAVAILABLE");
});
