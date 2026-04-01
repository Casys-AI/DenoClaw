import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { listAgentMemoryFiles } from "./loop_workspace.ts";
import { writeWorkspaceKv } from "./tools/file_workspace.ts";

Deno.test({
  name: "listAgentMemoryFiles reads workspace memories from KV in cloud mode",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const kv = await Deno.openKv(join(tmpDir, "workspace.db"));

    await writeWorkspaceKv(
      kv,
      "agent-cloud",
      "memories/project.md",
      "# Project",
    );
    await writeWorkspaceKv(
      kv,
      "agent-cloud",
      "memories/nested/todo.md",
      "# Todo",
    );

    const files = await listAgentMemoryFiles({
      agentId: "agent-cloud",
      kv,
      useWorkspaceKv: true,
    });

    assertEquals(files, ["nested/todo.md", "project.md"]);

    kv.close();
    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
