import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ReadFileTool, WriteFileTool } from "./file.ts";
import { readWorkspaceKv } from "./file_workspace.ts";

const reader = new ReadFileTool();
const writer = new WriteFileTool();

Deno.test("ReadFileTool reads existing file", async () => {
  const tmp = await Deno.makeTempFile();
  await Deno.writeTextFile(tmp, "test content");

  const result = await reader.execute({ path: tmp });
  assertEquals(result.success, true);
  assertEquals(result.output, "test content");

  await Deno.remove(tmp);
});

Deno.test("ReadFileTool fails on missing file", async () => {
  const result = await reader.execute({
    path: "/tmp/denoclaw-nonexistent-file-xyz",
  });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "FILE_NOT_FOUND");
});

Deno.test("ReadFileTool fails on missing arg", async () => {
  const result = await reader.execute({});
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "MISSING_ARG");
});

Deno.test("WriteFileTool dry_run by default", async () => {
  const result = await writer.execute({
    path: "/tmp/test.txt",
    content: "hello",
  });
  assertEquals(result.success, true);
  assertStringIncludes(result.output, "[dry_run]");
});

Deno.test("WriteFileTool writes with dry_run=false", async () => {
  const tmp = `${await Deno.makeTempDir()}/write-test.txt`;
  const result = await writer.execute({
    path: tmp,
    content: "hello world",
    dry_run: false,
  });
  assertEquals(result.success, true);

  const written = await Deno.readTextFile(tmp);
  assertEquals(written, "hello world");

  await Deno.remove(tmp);
});

// ── Scoped (workspace-aware) tests ──────────────────────────────

Deno.test("scoped ReadFileTool resolves relative path", async () => {
  const workspaceDir = await Deno.makeTempDir();
  const memoriesDir = join(workspaceDir, "memories");
  await Deno.mkdir(memoriesDir, { recursive: true });
  await Deno.writeTextFile(join(memoriesDir, "project.md"), "# Project notes");

  const scopedReader = new ReadFileTool({
    workspaceDir,
    agentId: "test-agent",
    onDeploy: false,
  });

  const result = await scopedReader.execute({
    path: "memories/project.md",
  });
  assertEquals(result.success, true);
  assertEquals(result.output, "# Project notes");

  await Deno.remove(workspaceDir, { recursive: true });
});

Deno.test("scoped ReadFileTool blocks path traversal", async () => {
  const workspaceDir = await Deno.makeTempDir();

  const scopedReader = new ReadFileTool({
    workspaceDir,
    agentId: "test-agent",
    onDeploy: false,
  });

  const result = await scopedReader.execute({
    path: "../../etc/passwd",
  });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "PATH_OUTSIDE_WORKSPACE");

  await Deno.remove(workspaceDir, { recursive: true });
});

Deno.test("scoped WriteFileTool creates file", async () => {
  const workspaceDir = await Deno.makeTempDir();
  const memoriesDir = join(workspaceDir, "memories");
  await Deno.mkdir(memoriesDir, { recursive: true });

  const scopedWriter = new WriteFileTool({
    workspaceDir,
    agentId: "test-agent",
    onDeploy: false,
  });

  const result = await scopedWriter.execute({
    path: "memories/notes.md",
    content: "# Notes",
    dry_run: false,
  });
  assertEquals(result.success, true);

  const written = await Deno.readTextFile(join(memoriesDir, "notes.md"));
  assertEquals(written, "# Notes");

  await Deno.remove(workspaceDir, { recursive: true });
});

Deno.test("scoped WriteFileTool dry_run still works", async () => {
  const workspaceDir = await Deno.makeTempDir();

  const scopedWriter = new WriteFileTool({
    workspaceDir,
    agentId: "test-agent",
    onDeploy: false,
  });

  const result = await scopedWriter.execute({
    path: "memories/notes.md",
    content: "# Notes",
    // dry_run defaults to true
  });
  assertEquals(result.success, true);
  assertStringIncludes(result.output, "[dry_run]");

  // File must not exist
  let exists = false;
  try {
    await Deno.stat(join(workspaceDir, "memories", "notes.md"));
    exists = true;
  } catch {
    // expected
  }
  assertEquals(exists, false);

  await Deno.remove(workspaceDir, { recursive: true });
});

Deno.test("unscoped ReadFileTool still reads absolute paths", async () => {
  const tmp = await Deno.makeTempFile();
  await Deno.writeTextFile(tmp, "absolute content");

  const unscopedReader = new ReadFileTool(); // no ctx
  const result = await unscopedReader.execute({ path: tmp });
  assertEquals(result.success, true);
  assertEquals(result.output, "absolute content");

  await Deno.remove(tmp);
});

Deno.test("scoped WriteFileTool writes to workspace KV on deploy", async () => {
  const workspaceDir = await Deno.makeTempDir();
  const kv = await Deno.openKv(join(workspaceDir, "workspace.db"));
  const scopedWriter = new WriteFileTool({
    workspaceDir,
    agentId: "test-agent",
    kv,
    onDeploy: true,
  });

  const result = await scopedWriter.execute({
    path: "memories/cloud.md",
    content: "# Cloud",
    dry_run: false,
  });

  assertEquals(result.success, true);
  assertEquals(
    await readWorkspaceKv(kv, "test-agent", "memories/cloud.md"),
    "# Cloud",
  );

  kv.close();
  await Deno.remove(workspaceDir, { recursive: true });
});

Deno.test("scoped ReadFileTool reads from workspace KV on deploy", async () => {
  const workspaceDir = await Deno.makeTempDir();
  const kv = await Deno.openKv(join(workspaceDir, "workspace.db"));
  const scopedWriter = new WriteFileTool({
    workspaceDir,
    agentId: "test-agent",
    kv,
    onDeploy: true,
  });
  const scopedReader = new ReadFileTool({
    workspaceDir,
    agentId: "test-agent",
    kv,
    onDeploy: true,
  });

  await scopedWriter.execute({
    path: "memories/cloud-read.md",
    content: "# Cloud Read",
    dry_run: false,
  });

  const result = await scopedReader.execute({
    path: "memories/cloud-read.md",
  });

  assertEquals(result.success, true);
  assertEquals(result.output, "# Cloud Read");

  kv.close();
  await Deno.remove(workspaceDir, { recursive: true });
});
