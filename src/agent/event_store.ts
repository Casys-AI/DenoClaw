import type { AgentEvent } from "./events.ts";

export interface EventStore {
  commit(event: AgentEvent): Promise<void>;
  getEvents(): Promise<AgentEvent[]>;
}

export class InMemoryEventStore implements EventStore {
  private events: AgentEvent[] = [];

  async commit(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }

  async getEvents(): Promise<AgentEvent[]> {
    return [...this.events];
  }
}
