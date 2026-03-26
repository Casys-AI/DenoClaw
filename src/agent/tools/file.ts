import type { ToolDefinition, ToolResult } from "../../types.ts";
import { BaseTool } from "./registry.ts";
import { dirname } from "@std/path";

export class ReadFileTool extends BaseTool {
  name = "read_file";
  description = "Read contents of a file";
  permissions = ["read" as const];

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
    if (!path) return this.fail("MISSING_ARG", { arg: "path" }, "Provide a file path");

    try {
      const content = await Deno.readTextFile(path);
      return this.ok(content);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("No such file")) {
        return this.fail("FILE_NOT_FOUND", { path }, "Check that the file path exists");
      }
      if (msg.includes("Permission denied")) {
        return this.fail("PERMISSION_DENIED", { path }, "Check file permissions");
      }
      return this.fail("READ_FAILED", { path, message: msg }, "Verify the path and permissions");
    }
  }
}

export class WriteFileTool extends BaseTool {
  name = "write_file";
  description = "Write content to a file (dry_run by default)";
  permissions = ["write" as const];

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
            dry_run: { type: "boolean", description: "Preview without writing (default: true)" },
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

    if (!path) return this.fail("MISSING_ARG", { arg: "path" }, "Provide a file path");
    if (content === undefined) return this.fail("MISSING_ARG", { arg: "content" }, "Provide content to write");

    if (dryRun) {
      return this.ok(`[dry_run] Would write ${content.length} chars to ${path}\nSet dry_run=false to write.`);
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
