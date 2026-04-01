import type { ToolResult } from "../shared/types.ts";

export interface ConversationContextRefreshState {
  reloadSkills: boolean;
  reloadMemoryFiles: boolean;
  reloadMemoryTopics: boolean;
}

export function createConversationContextRefreshState(): ConversationContextRefreshState {
  return {
    reloadSkills: false,
    reloadMemoryFiles: false,
    reloadMemoryTopics: false,
  };
}

export function applyConversationContextRefresh(
  state: ConversationContextRefreshState,
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult,
): void {
  if (!result.success) {
    return;
  }

  if (tool === "write_file") {
    if (args.dry_run !== false) {
      return;
    }
    const path = normalizeWorkspaceRelativePath(args.path);
    if (path?.startsWith("skills/")) {
      state.reloadSkills = true;
    }
    if (path?.startsWith("memories/")) {
      state.reloadMemoryFiles = true;
    }
    return;
  }

  if (tool === "memory") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "remember" || action === "forget") {
      state.reloadMemoryTopics = true;
    }
  }
}

function normalizeWorkspaceRelativePath(path: unknown): string | null {
  if (typeof path !== "string" || path.trim().length === 0) {
    return null;
  }
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
