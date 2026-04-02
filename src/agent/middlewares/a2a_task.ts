import type { Task } from "../../messaging/a2a/types.ts";
import {
  mapPrivilegeElevationPauseToInputRequiredTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../../messaging/a2a/task_mapping.ts";
import { extractRuntimePrivilegeElevationPause } from "../runtime_message_mapping.ts";
import type { CompleteEvent, ErrorEvent, ToolCallEvent, ToolResolution } from "../events.ts";
import type { Middleware } from "../middleware.ts";
import { log } from "../../shared/log.ts";

export class PrivilegeElevationPause extends Error {
  constructor(public readonly task: Task) {
    super("Privilege elevation pause");
    this.name = "PrivilegeElevationPause";
  }
}

export interface A2ATaskDeps {
  reportTaskResult(task: Task): Promise<void>;
}

export function a2aTaskMiddleware(deps: A2ATaskDeps): Middleware {
  return async (ctx, next) => {
    const task = ctx.session.canonicalTask;

    // Wrap tool_call: detect privilege elevation after execution
    if (ctx.event.type === "tool_call" && task) {
      const resolution = (await next()) as ToolResolution | undefined;
      if (resolution?.type === "tool") {
        const pause = extractRuntimePrivilegeElevationPause(resolution.result);
        if (pause) {
          const toolEvent = ctx.event as ToolCallEvent;
          const pausedTask = mapPrivilegeElevationPauseToInputRequiredTask(task, {
            grants: pause.grants, scope: pause.scope, prompt: pause.prompt,
            command: pause.command, binary: pause.binary,
            pendingTool: { tool: toolEvent.name, args: toolEvent.arguments, toolCallId: toolEvent.callId },
            expiresAt: pause.expiresAt,
          });
          try {
            await deps.reportTaskResult(pausedTask);
          } catch (reportErr) {
            log.error(`Failed to report INPUT_REQUIRED for privilege elevation (task ${task.id})`, reportErr);
            throw reportErr;
          }
          throw new PrivilegeElevationPause(pausedTask);
        }
      }
      return resolution;
    }

    // Report COMPLETED on complete event
    if (ctx.event.type === "complete" && task) {
      const e = ctx.event as CompleteEvent;
      const completed = mapTaskResultToCompletion(task, e.content);
      await deps.reportTaskResult(completed);
      return next();
    }

    // Report FAILED on error event
    if (ctx.event.type === "error" && task) {
      const e = ctx.event as ErrorEvent;
      log.warn(`Agent kernel error: ${e.code}${e.recovery ? ` — ${e.recovery}` : ""}`, {
        taskId: task.id,
        agentId: ctx.session.agentId,
      });
      const failed = mapTaskErrorToTerminalStatus(
        task,
        new Error(`${e.code}${e.recovery ? ` — ${e.recovery}` : ""}`),
      );
      await deps.reportTaskResult(failed);
      return next();
    }

    return next();
  };
}
