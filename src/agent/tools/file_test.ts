import { assertEquals, assertStringIncludes } from "@std/assert";
import { ReadFileTool, WriteFileTool } from "./file.ts";

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
