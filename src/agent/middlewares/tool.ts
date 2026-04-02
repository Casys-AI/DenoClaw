import type { ToolResult } from "../../shared/types.ts";
import type { ToolCallEvent, ToolResolution } from "../events.ts";
import type { Middleware } from "../middleware.ts";

export type ExecuteToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export function toolMiddleware(executeTool: ExecuteToolFn): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type !== "tool_call") return next();
    const req = ctx.event as ToolCallEvent;
    const result = await executeTool(req.name, req.arguments);
    const resolution: ToolResolution = { type: "tool", result };
    return resolution;
  };
}
