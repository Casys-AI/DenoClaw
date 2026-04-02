import type { AgentEvent, EventResolution } from "./events.ts";
import type { AgentRuntimeGrant } from "./runtime_capabilities.ts";
import type { Task } from "../messaging/a2a/types.ts";

export interface SessionState {
  agentId: string;
  sessionId: string;
  memoryTopics: string[];
  memoryFiles: string[];
  canonicalTask?: Task;
  runtimeGrants?: AgentRuntimeGrant[];
}

export interface MiddlewareContext {
  event: AgentEvent;
  session: SessionState;
}

export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<EventResolution | undefined>,
) => Promise<EventResolution | undefined>;

export class MiddlewarePipeline {
  private stack: Middleware[] = [];

  use(mw: Middleware): this {
    this.stack.push(mw);
    return this;
  }

  execute(
    event: AgentEvent,
    session: SessionState,
  ): Promise<EventResolution | undefined> {
    let index = 0;
    const next = (): Promise<EventResolution | undefined> => {
      if (index >= this.stack.length) return Promise.resolve(undefined);
      const mw = this.stack[index++];
      return mw({ event, session }, next);
    };
    return next();
  }
}
