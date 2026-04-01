import { join, normalize } from "node:path";
import { isDeployEnvironment } from "../../shared/helpers.ts";

export interface WorkspaceContext {
  workspaceDir: string; // absolute path to data/agents/<id>/
  agentId: string;
  kv?: Deno.Kv; // for Deploy KV backend
  onDeploy?: boolean; // override for tests (default: checks DENO_DEPLOYMENT_ID)
}

export interface ResolvedWorkspaceAccess {
  blocked: boolean;
  resolvedPath: string;
  isDeploy: boolean;
}

export function resolveWorkspaceAccess(
  inputPath: string,
  ctx: WorkspaceContext,
): ResolvedWorkspaceAccess {
  const resolvedPath = normalize(join(ctx.workspaceDir, inputPath));
  return {
    blocked: !resolvedPath.startsWith(ctx.workspaceDir),
    resolvedPath,
    isDeploy: ctx.onDeploy ?? isDeployEnvironment(),
  };
}

export function createWorkspaceKvKey(
  agentId: string,
  relativePath: string,
): Deno.KvKey {
  const parts = relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  return ["workspace", agentId, ...parts];
}

function createLegacyWorkspaceKvKey(
  agentId: string,
  relativePath: string,
): Deno.KvKey {
  return ["workspace", agentId, relativePath.replaceAll("\\", "/")];
}

export async function readWorkspaceKv(
  kv: Deno.Kv,
  agentId: string,
  relativePath: string,
): Promise<string | null> {
  const key = createWorkspaceKvKey(agentId, relativePath);
  const entry = await kv.get<string>(key);
  if (entry.value !== null) {
    return entry.value;
  }

  if (key.length === 3 && key[2] === relativePath) {
    return null;
  }

  const legacyEntry = await kv.get<string>(
    createLegacyWorkspaceKvKey(agentId, relativePath),
  );
  return legacyEntry.value;
}

export async function listWorkspaceKvFiles(
  kv: Deno.Kv,
  agentId: string,
  directory: string,
): Promise<string[]> {
  const normalizedDirectory = directory
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  const files = new Set<string>();

  for await (
    const entry of kv.list<string>({
      prefix: createWorkspaceKvKey(agentId, normalizedDirectory),
    })
  ) {
    const relativeParts = entry.key.slice(2);
    if (relativeParts.length < 2) continue;
    files.add(relativeParts.slice(1).join("/"));
  }

  for await (const entry of kv.list<string>({ prefix: ["workspace", agentId] })) {
    const legacyPath = entry.key[2];
    if (
      typeof legacyPath !== "string" ||
      !legacyPath.startsWith(`${normalizedDirectory}/`)
    ) {
      continue;
    }
    files.add(legacyPath.slice(normalizedDirectory.length + 1));
  }

  return [...files].sort();
}

export async function writeWorkspaceKv(
  kv: Deno.Kv,
  agentId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await kv.set(createWorkspaceKvKey(agentId, relativePath), content);
}
