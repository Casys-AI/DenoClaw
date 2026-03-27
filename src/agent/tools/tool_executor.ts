#!/usr/bin/env -S deno run
/**
 * Tool executor — runs in a subprocess with restricted Deno permissions.
 *
 * Spawned by LocalProcessBackend via Deno.Command with --allow-* flags
 * matching the tool×agent permission intersection (ADR-005).
 * Exec policy is enforced BEFORE spawn by the backend (ADR-010).
 *
 * Input: JSON string as first CLI arg: { tool, args, config? }
 * Output: ToolResult JSON on stdout
 */

import { ShellTool } from "./shell.ts";
import { ReadFileTool, WriteFileTool } from "./file.ts";
import { WebFetchTool } from "./web.ts";
import type { ToolResult } from "../../shared/types.ts";

interface ExecutorInput {
  tool: string;
  args: Record<string, unknown>;
  config?: {
    restrictToWorkspace?: boolean;
  };
}

function instantiateTool(name: string, config?: ExecutorInput["config"]) {
  switch (name) {
    case "shell":
      return new ShellTool(config?.restrictToWorkspace);
    case "read_file":
      return new ReadFileTool();
    case "write_file":
      return new WriteFileTool();
    case "web_fetch":
      return new WebFetchTool();
    default:
      return null;
  }
}

try {
  const raw = Deno.args[0];
  if (!raw) {
    const err: ToolResult = {
      success: false,
      output: "",
      error: {
        code: "EXECUTOR_NO_INPUT",
        recovery: "Pass JSON as first CLI arg",
      },
    };
    console.log(JSON.stringify(err));
    Deno.exit(1);
  }

  const input: ExecutorInput = JSON.parse(raw);
  const tool = instantiateTool(input.tool, input.config);

  if (!tool) {
    const err: ToolResult = {
      success: false,
      output: "",
      error: {
        code: "EXECUTOR_UNKNOWN_TOOL",
        context: { tool: input.tool },
        recovery: "Use a registered tool name",
      },
    };
    console.log(JSON.stringify(err));
    Deno.exit(1);
  }

  const result = await tool.execute(input.args);
  console.log(JSON.stringify(result));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  const err: ToolResult = {
    success: false,
    output: "",
    error: {
      code: "EXECUTOR_CRASH",
      context: { message: msg },
      recovery: "Check tool args and permissions",
    },
  };
  console.log(JSON.stringify(err));
  Deno.exit(1);
}
