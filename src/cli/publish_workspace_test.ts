import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "../shared/helpers.ts";
import { buildPublishedWorkspaceSnapshot } from "./publish_workspace.ts";

Deno.test("buildPublishedWorkspaceSnapshot reads soul, skills, and memories", async () => {
  const tmpDir = await Deno.makeTempDir();
  const agentDir = join(tmpDir, "data", "agents", "alice");

  try {
    await ensureDir(join(agentDir, "skills", "nested"));
    await ensureDir(join(agentDir, "memories"));
    await Deno.writeTextFile(join(agentDir, "soul.md"), "You are Alice.\n");

    await Deno.writeTextFile(
      join(agentDir, "skills", "nested", "generated.md"),
      "# Skill\n",
    );
    await Deno.writeTextFile(
      join(agentDir, "memories", "project.md"),
      "# Project\n",
    );

    const snapshot = await buildPublishedWorkspaceSnapshot("alice", {
      agentDir,
      syncId: "publish-1",
      syncMode: "force",
    });

    assertEquals(snapshot.syncId, "publish-1");
    assertEquals(snapshot.syncMode, "force");
    assertEquals(snapshot.files, [
      { path: "memories/project.md", content: "# Project\n" },
      { path: "skills/nested/generated.md", content: "# Skill\n" },
      { path: "soul.md", content: "You are Alice.\n" },
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("buildPublishedWorkspaceSnapshot materializes soul.md from resolved system prompt", async () => {
  const tmpDir = await Deno.makeTempDir();
  const agentDir = join(tmpDir, "data", "agents", "alice");

  try {
    await ensureDir(join(agentDir, "skills"));

    const snapshot = await buildPublishedWorkspaceSnapshot("alice", {
      agentDir,
      systemPrompt: "Synthetic prompt\n",
    });

    assertEquals(snapshot.files, [
      { path: "soul.md", content: "Synthetic prompt\n" },
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
