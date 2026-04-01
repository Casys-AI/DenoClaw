import {
  readWorkspaceKv,
  writeWorkspaceKv,
} from "./tools/file_workspace.ts";

export type WorkspaceSyncMode = "preserve" | "force";

export interface PublishedWorkspaceFile {
  path: string;
  content: string;
}

export interface PublishedWorkspaceSnapshot {
  syncId: string;
  syncMode: WorkspaceSyncMode;
  files: PublishedWorkspaceFile[];
}

export interface PublishedWorkspaceSyncResult {
  syncId: string;
  mode: WorkspaceSyncMode;
  fileCount: number;
  alreadyApplied: boolean;
  created: number;
  updated: number;
  skipped: number;
}

interface PublishedWorkspaceSyncState {
  syncId: string;
  syncMode: WorkspaceSyncMode;
  fileCount: number;
  appliedAt: string;
}

export function createPublishedWorkspaceSyncStateKey(
  agentId: string,
): Deno.KvKey {
  return ["workspace_sync", agentId, "state"];
}

export async function syncPublishedWorkspaceSnapshot(
  kv: Deno.Kv,
  agentId: string,
  snapshot: PublishedWorkspaceSnapshot,
): Promise<PublishedWorkspaceSyncResult> {
  const syncStateKey = createPublishedWorkspaceSyncStateKey(agentId);
  const currentState = await kv.get<PublishedWorkspaceSyncState>(syncStateKey);
  if (currentState.value?.syncId === snapshot.syncId) {
    return {
      syncId: snapshot.syncId,
      mode: snapshot.syncMode,
      fileCount: snapshot.files.length,
      alreadyApplied: true,
      created: 0,
      updated: 0,
      skipped: snapshot.files.length,
    };
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of snapshot.files) {
    const existing = await readWorkspaceKv(kv, agentId, file.path);
    if (existing === null) {
      await writeWorkspaceKv(kv, agentId, file.path, file.content);
      created += 1;
      continue;
    }

    if (existing === file.content) {
      skipped += 1;
      continue;
    }

    if (snapshot.syncMode === "force") {
      await writeWorkspaceKv(kv, agentId, file.path, file.content);
      updated += 1;
      continue;
    }

    skipped += 1;
  }

  await kv.set(syncStateKey, {
    syncId: snapshot.syncId,
    syncMode: snapshot.syncMode,
    fileCount: snapshot.files.length,
    appliedAt: new Date().toISOString(),
  } satisfies PublishedWorkspaceSyncState);

  return {
    syncId: snapshot.syncId,
    mode: snapshot.syncMode,
    fileCount: snapshot.files.length,
    alreadyApplied: false,
    created,
    updated,
    skipped,
  };
}
