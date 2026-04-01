/**
 * Agent tools domain types — phase 2 DDD migration.
 */

import type { SandboxPermission } from "../../shared/types.ts";

export type BuiltinToolName =
  | "shell"
  | "read_file"
  | "write_file"
  | "web_fetch"
  | "create_cron"
  | "list_crons"
  | "delete_cron";

export const BUILTIN_TOOL_PERMISSIONS: Readonly<
  Record<BuiltinToolName, readonly SandboxPermission[]>
> = {
  shell: ["run"],
  read_file: ["read"],
  write_file: ["write"],
  web_fetch: ["net"],
  create_cron: [],
  list_crons: [],
  delete_cron: [],
} as const;
