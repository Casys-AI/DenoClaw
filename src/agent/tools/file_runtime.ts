import { dirname } from "node:path";
import type { ToolResult } from "../../shared/types.ts";

export function createDryRunWriteResult(
  path: string,
  content: string,
): ToolResult {
  return {
    success: true,
    output:
      `[dry_run] Would write ${content.length} chars to ${path}\nSet dry_run=false to write.`,
  };
}

export async function readTextFileResult(
  path: string,
  resolvedPath: string,
): Promise<ToolResult> {
  try {
    const content = await Deno.readTextFile(resolvedPath);
    return { success: true, output: content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No such file") || message.includes("os error 2")) {
      return failResult(
        "FILE_NOT_FOUND",
        { path },
        "Check that the file path exists",
      );
    }
    if (message.includes("Permission denied")) {
      return failResult(
        "PERMISSION_DENIED",
        { path },
        "Check file permissions",
      );
    }
    return failResult(
      "READ_FAILED",
      { path, message },
      "Verify the path and permissions",
    );
  }
}

export async function writeTextFileResult(
  path: string,
  resolvedPath: string,
  content: string,
): Promise<ToolResult> {
  try {
    await Deno.mkdir(dirname(resolvedPath), { recursive: true }).catch(
      () => {},
    );
    await Deno.writeTextFile(resolvedPath, content);
    return {
      success: true,
      output: `Written ${content.length} chars to ${path}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failResult(
      "WRITE_FAILED",
      { path, message },
      "Check path and permissions",
    );
  }
}

function failResult(
  code: string,
  context?: Record<string, unknown>,
  recovery?: string,
): ToolResult {
  return {
    success: false,
    output: "",
    error: { code, context, recovery },
  };
}
