import type { ToolResultEvent } from "../events.ts";
import type { Middleware } from "../middleware.ts";

interface ContextRefreshState {
  reloadSkills: boolean;
  reloadMemoryFiles: boolean;
  reloadMemoryTopics: boolean;
}

export interface ContextRefreshDeps {
  skills: { reload(): Promise<void> };
  memory: { listTopics(): Promise<string[]> };
  refreshMemoryFiles: (() => Promise<string[]>) | undefined;
}

export function contextRefreshMiddleware(deps: ContextRefreshDeps): Middleware {
  let refreshState: ContextRefreshState = {
    reloadSkills: false, reloadMemoryFiles: false, reloadMemoryTopics: false,
  };
  let lastRefreshedIteration = 0;

  return async (ctx, next) => {
    // Apply pending refreshes at the start of a new iteration
    if (ctx.event.type === "llm_request" && ctx.event.iterationId > lastRefreshedIteration) {
      if (refreshState.reloadSkills) await deps.skills.reload();
      if (refreshState.reloadMemoryFiles && deps.refreshMemoryFiles) {
        ctx.session.memoryFiles = await deps.refreshMemoryFiles();
      }
      if (refreshState.reloadMemoryTopics) {
        ctx.session.memoryTopics = await deps.memory.listTopics();
      }
      lastRefreshedIteration = ctx.event.iterationId;
      refreshState = { reloadSkills: false, reloadMemoryFiles: false, reloadMemoryTopics: false };
    }

    // Detect refresh triggers on tool_result
    if (ctx.event.type === "tool_result") {
      const e = ctx.event as ToolResultEvent;
      if (e.result.success) {
        applyRefreshDetection(refreshState, e.name, e.arguments);
      }
    }
    return next();
  };
}

function applyRefreshDetection(
  state: ContextRefreshState, tool: string, args: Record<string, unknown>,
): void {
  if (tool === "write_file") {
    // Only trigger reload on actual writes — dry_run: true and dry_run: undefined (omitted) both skip.
    if (args.dry_run !== false) return;
    const path = normalizeWorkspaceRelativePath(args.path);
    if (path?.startsWith("skills/")) state.reloadSkills = true;
    if (path?.startsWith("memories/")) state.reloadMemoryFiles = true;
    return;
  }
  if (tool === "memory") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "remember" || action === "forget") state.reloadMemoryTopics = true;
  }
}

function normalizeWorkspaceRelativePath(path: unknown): string | null {
  if (typeof path !== "string" || path.trim().length === 0) return null;
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
