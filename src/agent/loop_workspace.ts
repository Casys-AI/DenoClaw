import { join } from "@std/path";
import { listWorkspaceKvFiles } from "./tools/file_workspace.ts";

export interface AgentMemoryFileListInput {
  agentId: string;
  workspaceDir?: string;
  kv?: Deno.Kv;
  useWorkspaceKv?: boolean;
}

export async function listAgentMemoryFiles(
  input: AgentMemoryFileListInput,
): Promise<string[]> {
  if (input.useWorkspaceKv) {
    if (!input.kv) return [];
    const files = await listWorkspaceKvFiles(input.kv, input.agentId, "memories");
    return files.filter((file) => file.endsWith(".md"));
  }

  if (!input.workspaceDir) return [];

  const memoriesDir = join(input.workspaceDir, "memories");
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
