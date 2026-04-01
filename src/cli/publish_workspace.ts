import { join, relative } from "@std/path";
import type {
  PublishedWorkspaceFile,
  PublishedWorkspaceSnapshot,
  WorkspaceSyncMode,
} from "../agent/published_workspace.ts";
import {
  fileExists,
  getAgentDefDir,
} from "../shared/helpers.ts";

interface BuildPublishedWorkspaceSnapshotOptions {
  agentDir?: string;
  syncId?: string;
  syncMode?: WorkspaceSyncMode;
}

export async function buildPublishedWorkspaceSnapshot(
  agentId: string,
  options: BuildPublishedWorkspaceSnapshotOptions = {},
): Promise<PublishedWorkspaceSnapshot> {
  const agentDir = options.agentDir ?? getAgentDefDir(agentId);
  const files = [
    ...await collectWorkspaceFiles(join(agentDir, "skills"), "skills"),
    ...await collectWorkspaceFiles(join(agentDir, "memories"), "memories"),
  ].sort((a, b) => a.path.localeCompare(b.path));

  return {
    syncId: options.syncId ?? crypto.randomUUID(),
    syncMode: options.syncMode ?? "preserve",
    files,
  };
}

async function collectWorkspaceFiles(
  rootDir: string,
  topLevelDir: "skills" | "memories",
): Promise<PublishedWorkspaceFile[]> {
  if (!await fileExists(rootDir)) {
    return [];
  }

  const files: PublishedWorkspaceFile[] = [];
  await walkWorkspaceDir(rootDir, async (fullPath) => {
    const relativePath = relative(rootDir, fullPath).replaceAll("\\", "/");
    files.push({
      path: join(topLevelDir, relativePath).replaceAll("\\", "/"),
      content: await Deno.readTextFile(fullPath),
    });
  });
  return files;
}

async function walkWorkspaceDir(
  dir: string,
  onFile: (path: string) => Promise<void>,
): Promise<void> {
  const entries = [];
  for await (const entry of Deno.readDir(dir)) {
    entries.push(entry);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      await walkWorkspaceDir(path, onFile);
      continue;
    }
    if (entry.isFile) {
      await onFile(path);
    }
  }
}
