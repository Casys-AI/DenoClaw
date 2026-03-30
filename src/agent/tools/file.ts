import type { ToolDefinition, ToolResult } from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";
import {
  createDryRunWriteResult,
  readTextFileResult,
  writeTextFileResult,
} from "./file_runtime.ts";
import type { WorkspaceContext } from "./file_workspace.ts";
import {
  readWorkspaceKv,
  resolveWorkspaceAccess,
  writeWorkspaceKv,
} from "./file_workspace.ts";

export type { WorkspaceContext } from "./file_workspace.ts";

export class ReadFileTool extends BaseTool {
  name = "read_file";
  description = "Read contents of a file";
  permissions = ["read" as const];

  private ctx?: WorkspaceContext;

  constructor(ctx?: WorkspaceContext) {
    super();
    this.ctx = ctx;
  }

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to read" },
          },
          required: ["path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;
    if (!path) {
      return this.fail("MISSING_ARG", { arg: "path" }, "Provide a file path");
    }

    if (this.ctx) {
      const { blocked, resolvedPath, isDeploy } = resolveWorkspaceAccess(
        path,
        this.ctx,
      );
      if (blocked) {
        return this.fail(
          "PATH_OUTSIDE_WORKSPACE",
          { path },
          "Use a path relative to the workspace (e.g. memories/project.md)",
        );
      }

      if (isDeploy && this.ctx.kv) {
        const content = await readWorkspaceKv(
          this.ctx.kv,
          this.ctx.agentId,
          path,
        );
        if (content === null) {
          return this.fail(
            "FILE_NOT_FOUND",
            { path },
            "Check that the workspace file exists",
          );
        }
        return this.ok(content);
      }

      return readTextFileResult(path, resolvedPath);
    }

    // Unscoped mode — original behavior
    return readTextFileResult(path, path);
  }
}

export class WriteFileTool extends BaseTool {
  name = "write_file";
  description = "Write content to a file (dry_run by default)";
  permissions = ["write" as const];

  private ctx?: WorkspaceContext;

  constructor(ctx?: WorkspaceContext) {
    super();
    this.ctx = ctx;
  }

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to write" },
            content: { type: "string", description: "Content to write" },
            dry_run: {
              type: "boolean",
              description: "Preview without writing (default: true)",
            },
          },
          required: ["path", "content"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;
    const content = args.content as string;
    const dryRun = args.dry_run !== false; // AX: safe default

    if (!path) {
      return this.fail("MISSING_ARG", { arg: "path" }, "Provide a file path");
    }
    if (content === undefined) {
      return this.fail(
        "MISSING_ARG",
        { arg: "content" },
        "Provide content to write",
      );
    }

    if (this.ctx) {
      const { blocked, resolvedPath, isDeploy } = resolveWorkspaceAccess(
        path,
        this.ctx,
      );
      if (blocked) {
        return this.fail(
          "PATH_OUTSIDE_WORKSPACE",
          { path },
          "Use a path relative to the workspace (e.g. memories/project.md)",
        );
      }

      if (dryRun) {
        return createDryRunWriteResult(path, content);
      }

      if (isDeploy && this.ctx.kv) {
        await writeWorkspaceKv(this.ctx.kv, this.ctx.agentId, path, content);
        return this.ok(`Written ${content.length} chars to ${path}`);
      }

      return writeTextFileResult(path, resolvedPath, content);
    }

    // Unscoped mode — original behavior
    if (dryRun) {
      return createDryRunWriteResult(path, content);
    }
    return writeTextFileResult(path, path, content);
  }
}
