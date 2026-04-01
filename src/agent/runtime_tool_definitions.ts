import type { ToolDefinition } from "../shared/types.ts";
import { ReadFileTool, WriteFileTool } from "./tools/file.ts";
import { CreateCronTool, DeleteCronTool, ListCronsTool } from "./tools/cron.ts";
import { ShellTool } from "./tools/shell.ts";
import { WebFetchTool } from "./tools/web.ts";

/**
 * Broker-backed runtime tools exposed to deployed agents.
 *
 * Keep this aligned with the tools the broker can execute directly on behalf of
 * the agent. Capability metadata still tells the model what is currently
 * allowed; the tool list stays present so privilege elevation can be requested.
 */
export function createBrokerBackedRuntimeToolDefinitions(): ToolDefinition[] {
  return [
    new ShellTool().getDefinition(),
    new ReadFileTool().getDefinition(),
    new WriteFileTool().getDefinition(),
    new WebFetchTool().getDefinition(),
    new CreateCronTool().getDefinition(),
    new ListCronsTool().getDefinition(),
    new DeleteCronTool().getDefinition(),
  ];
}
