/**
 * Agent tools domain types — phase 2 DDD migration.
 */

import type { SandboxPermission } from "../../shared/mod.ts";

export type BuiltinToolName =
  | "shell"
  | "read_file"
  | "write_file"
  | "web_fetch";

export const BUILTIN_TOOL_PERMISSIONS: Readonly<
  Record<BuiltinToolName, readonly SandboxPermission[]>
> = {
  shell: ["run"],
  read_file: ["read"],
  write_file: ["write"],
  web_fetch: ["net"],
} as const;
