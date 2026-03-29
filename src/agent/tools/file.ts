import type { ToolDefinition, ToolResult } from "../../shared/mod.ts";
import { BaseTool } from "./registry.ts";
import { dirname, join, normalize } from "@std/path";

export interface WorkspaceContext {
  workspaceDir: string; // absolute path to data/agents/<id>/
  agentId: string;
  kv?: Deno.Kv; // for Deploy KV backend
  onDeploy?: boolean; // override for tests (default: checks DENO_DEPLOYMENT_ID)
}

function resolveWorkspacePath(
  inputPath: string,
  workspaceDir: string,
): { resolved: string; blocked: boolean } {
  const norm = normalize(join(workspaceDir, inputPath));
  if (!norm.startsWith(workspaceDir)) {
    return { resolved: "", blocked: true };
  }
  return { resolved: norm, blocked: false };
}

async function kvRead(
  kv: Deno.Kv,
  agentId: string,
  relativePath: string,
): Promise<string | null> {
  const entry = await kv.get<string>(["workspace", agentId, relativePath]);
  return entry.value;
}

async function kvWrite(
  kv: Deno.Kv,
  agentId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await kv.set(["workspace", agentId, relativePath], content);
}

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
      const { resolved, blocked } = resolveWorkspacePath(
        path,
        this.ctx.workspaceDir,
      );
      if (blocked) {
        return this.fail(
          "PATH_OUTSIDE_WORKSPACE",
          { path },
          "Use a path relative to the workspace (e.g. memories/project.md)",
        );
      }

      const isOnDeploy = this.ctx.onDeploy ??
        !!Deno.env.get("DENO_DEPLOYMENT_ID");

      if (isOnDeploy && this.ctx.kv) {
        const content = await kvRead(this.ctx.kv, this.ctx.agentId, path);
        if (content === null) {
          return this.fail(
            "FILE_NOT_FOUND",
            { path },
            "Check that the workspace file exists",
          );
        }
        return this.ok(content);
      }

      try {
        const content = await Deno.readTextFile(resolved);
        return this.ok(content);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("No such file") || msg.includes("os error 2")) {
          return this.fail(
            "FILE_NOT_FOUND",
            { path },
            "Check that the file path exists",
          );
        }
        if (msg.includes("Permission denied")) {
          return this.fail(
            "PERMISSION_DENIED",
            { path },
            "Check file permissions",
          );
        }
        return this.fail(
          "READ_FAILED",
          { path, message: msg },
          "Verify the path and permissions",
        );
      }
    }

    // Unscoped mode — original behavior
    try {
      const content = await Deno.readTextFile(path);
      return this.ok(content);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("No such file") || msg.includes("os error 2")) {
        return this.fail(
          "FILE_NOT_FOUND",
          { path },
          "Check that the file path exists",
        );
      }
      if (msg.includes("Permission denied")) {
        return this.fail(
          "PERMISSION_DENIED",
          { path },
          "Check file permissions",
        );
      }
      return this.fail(
        "READ_FAILED",
        { path, message: msg },
        "Verify the path and permissions",
      );
    }
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
      const { resolved, blocked } = resolveWorkspacePath(
        path,
        this.ctx.workspaceDir,
      );
      if (blocked) {
        return this.fail(
          "PATH_OUTSIDE_WORKSPACE",
          { path },
          "Use a path relative to the workspace (e.g. memories/project.md)",
        );
      }

      if (dryRun) {
        return this.ok(
          `[dry_run] Would write ${content.length} chars to ${path}\nSet dry_run=false to write.`,
        );
      }

      const isOnDeploy = this.ctx.onDeploy ??
        !!Deno.env.get("DENO_DEPLOYMENT_ID");

      if (isOnDeploy && this.ctx.kv) {
        await kvWrite(this.ctx.kv, this.ctx.agentId, path, content);
        return this.ok(`Written ${content.length} chars to ${path}`);
      }

      try {
        await Deno.mkdir(dirname(resolved), { recursive: true }).catch(
          () => {},
        );
        await Deno.writeTextFile(resolved, content);
        return this.ok(`Written ${content.length} chars to ${path}`);
      } catch (e) {
        return this.fail(
          "WRITE_FAILED",
          { path, message: (e as Error).message },
          "Check path and permissions",
        );
      }
    }

    // Unscoped mode — original behavior
    if (dryRun) {
      return this.ok(
        `[dry_run] Would write ${content.length} chars to ${path}\nSet dry_run=false to write.`,
      );
    }

    try {
      await Deno.mkdir(dirname(path), { recursive: true }).catch(() => {});
      await Deno.writeTextFile(path, content);
      return this.ok(`Written ${content.length} chars to ${path}`);
    } catch (e) {
      return this.fail(
        "WRITE_FAILED",
        { path, message: (e as Error).message },
        "Check path and permissions",
      );
    }
  }
}
