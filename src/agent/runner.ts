import type { AgentResponse } from "./types.ts";
import type { FinalEvent } from "./events.ts";
import { agentKernel } from "./kernel.ts";
import type { KernelInput } from "./kernel.ts";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import type { EventStore } from "./event_store.ts";
import { PrivilegeElevationPause } from "./middlewares/a2a_task.ts";
import type { Message } from "../shared/types.ts";

interface MemoryReader {
  getMessages(): Message[];
}

export class AgentRunner {
  constructor(
    private pipeline: MiddlewarePipeline,
    private eventStore: EventStore,
    private session: SessionState,
    private memory: MemoryReader,
  ) {}

  async run(input: KernelInput): Promise<AgentResponse> {
    const kernel = agentKernel(input);
    let next = await kernel.next();

    try {
      while (!next.done) {
        const event = next.value;
        await this.eventStore.commit(event);
        const resolution = await this.pipeline.execute(event, this.session);
        next = await kernel.next(resolution);
      }

      const finalEvent = next.value;
      await this.eventStore.commit(finalEvent);
      // Pass final event through pipeline (observation for a2a/observability)
      await this.pipeline.execute(finalEvent, this.session);
      return this.toAgentResult(finalEvent);
    } catch (e) {
      if (e instanceof PrivilegeElevationPause) {
        return { content: "", finishReason: "privilege_elevation_pause" };
      }
      throw e;
    }
  }

  private toAgentResult(event: FinalEvent): AgentResponse {
    if (event.type === "complete") {
      return {
        content: event.content,
        finishReason: event.finishReason ?? "stop",
      };
    }
    // Error (max_iterations) — return last assistant message
    const messages = this.memory.getMessages();
    const last = messages.findLast((m) => m.role === "assistant");
    return {
      content: last?.content ?? "Max iterations reached without a final response.",
      finishReason: "max_iterations",
    };
  }
}
