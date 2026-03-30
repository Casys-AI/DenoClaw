import { join } from "@std/path";

export async function listAgentMemoryFiles(
  workspaceDir: string,
): Promise<string[]> {
  const memoriesDir = join(workspaceDir, "memories");
  try {
    const files: string[] = [];
    for await (const entry of Deno.readDir(memoriesDir)) {
      if (entry.isFile && entry.name.endsWith(".md")) files.push(entry.name);
    }
    return files.sort();
  } catch {
    return [];
  }
}
