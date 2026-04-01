import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { KvSkillsLoader, SkillsLoader } from "./skills.ts";
import { writeWorkspaceKv } from "./tools/file_workspace.ts";

Deno.test({
  name: "SkillsLoader loads .md files from directory",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    await Deno.writeTextFile(
      `${tmpDir}/test-skill.md`,
      "# Test Skill\nThis is a test skill.\n\nContent here.",
    );

    const loader = new SkillsLoader(tmpDir);
    await loader.loadSkills();

    const skills = loader.getSkills();
    assertEquals(skills.length, 1);
    assertEquals(skills[0].name, "Test Skill");
    assertEquals(skills[0].description, "This is a test skill.");

    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SkillsLoader handles empty directory",
  async fn() {
    const tmpDir = await Deno.makeTempDir();

    const loader = new SkillsLoader(tmpDir);
    await loader.loadSkills();

    assertEquals(loader.getSkills().length, 0);
    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SkillsLoader handles nonexistent directory",
  async fn() {
    const loader = new SkillsLoader("/tmp/denoclaw-nonexistent-dir");
    await loader.loadSkills();
    assertEquals(loader.getSkills().length, 0);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SkillsLoader uses filename when no heading",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    await Deno.writeTextFile(
      `${tmpDir}/no-heading.md`,
      "Just some content without heading.",
    );

    const loader = new SkillsLoader(tmpDir);
    await loader.loadSkills();

    const skill = loader.getSkill("no-heading");
    assertEquals(skill?.name, "no-heading");

    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "KvSkillsLoader loads .md files from workspace KV",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const kv = await Deno.openKv(join(tmpDir, "skills.db"));

    await writeWorkspaceKv(
      kv,
      "agent-kv",
      "skills/test-skill.md",
      "# KV Skill\nLoaded from KV.\n\nContent here.",
    );
    await writeWorkspaceKv(
      kv,
      "agent-kv",
      "skills/ignore.txt",
      "ignore me",
    );

    const loader = new KvSkillsLoader(kv, "agent-kv");
    await loader.loadSkills();

    const skills = loader.getSkills();
    assertEquals(skills.length, 1);
    assertEquals(skills[0].name, "KV Skill");
    assertEquals(skills[0].description, "Loaded from KV.");

    kv.close();
    await Deno.remove(tmpDir, { recursive: true });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
