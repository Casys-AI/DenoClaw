import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createPublishedWorkspaceSyncStateKey,
  syncPublishedWorkspaceSnapshot,
  type PublishedWorkspaceSnapshot,
} from "./published_workspace.ts";
import { readWorkspaceKv, writeWorkspaceKv } from "./tools/file_workspace.ts";

function createSnapshot(
  syncId: string,
  syncMode: "preserve" | "force",
): PublishedWorkspaceSnapshot {
  return {
    syncId,
    syncMode,
    files: [{
      path: "skills/generated.md",
      content: "# Generated\n",
    }],
  };
}

Deno.test({
  name: "syncPublishedWorkspaceSnapshot preserves existing KV files by default",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const kv = await Deno.openKv(join(tmpDir, "workspace.db"));

    await writeWorkspaceKv(kv, "agent-cloud", "skills/generated.md", "# Remote\n");

    const result = await syncPublishedWorkspaceSnapshot(
      kv,
      "agent-cloud",
      createSnapshot("sync-preserve", "preserve"),
    );

    assertEquals(result.created, 0);
    assertEquals(result.updated, 0);
    assertEquals(result.skipped, 1);
    assertEquals(
      await readWorkspaceKv(kv, "agent-cloud", "skills/generated.md"),
      "# Remote\n",
    );

    kv.close();
    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "syncPublishedWorkspaceSnapshot force-overwrites tracked files once per publish sync id",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const kv = await Deno.openKv(join(tmpDir, "workspace.db"));

    await writeWorkspaceKv(kv, "agent-cloud", "skills/generated.md", "# Remote\n");

    const first = await syncPublishedWorkspaceSnapshot(
      kv,
      "agent-cloud",
      createSnapshot("sync-force", "force"),
    );
    assertEquals(first.created, 0);
    assertEquals(first.updated, 1);
    assertEquals(
      await readWorkspaceKv(kv, "agent-cloud", "skills/generated.md"),
      "# Generated\n",
    );

    await writeWorkspaceKv(kv, "agent-cloud", "skills/generated.md", "# Evolved\n");

    const second = await syncPublishedWorkspaceSnapshot(
      kv,
      "agent-cloud",
      createSnapshot("sync-force", "force"),
    );
    assertEquals(second.alreadyApplied, true);
    assertEquals(
      await readWorkspaceKv(kv, "agent-cloud", "skills/generated.md"),
      "# Evolved\n",
    );

    const syncState = await kv.get<{
      syncId: string;
      syncMode: string;
      fileCount: number;
    }>(createPublishedWorkspaceSyncStateKey("agent-cloud"));
    assertEquals(syncState.value?.syncId, "sync-force");
    assertEquals(syncState.value?.syncMode, "force");
    assertEquals(syncState.value?.fileCount, 1);

    kv.close();
    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
