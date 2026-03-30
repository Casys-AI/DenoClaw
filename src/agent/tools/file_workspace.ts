import { join, normalize } from "@std/path";

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
    isDeploy: ctx.onDeploy ?? !!Deno.env.get("DENO_DEPLOYMENT_ID"),
  };
}

export async function readWorkspaceKv(
  kv: Deno.Kv,
  agentId: string,
  relativePath: string,
): Promise<string | null> {
  const entry = await kv.get<string>(["workspace", agentId, relativePath]);
  return entry.value;
}

export async function writeWorkspaceKv(
  kv: Deno.Kv,
  agentId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await kv.set(["workspace", agentId, relativePath], content);
}
