import type { AgentEvent } from "./events.ts";

export interface EventStore {
  commit(event: AgentEvent): Promise<void>;
  getEvents(): Promise<AgentEvent[]>;
}

export class InMemoryEventStore implements EventStore {
  private events: AgentEvent[] = [];

  commit(event: AgentEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  getEvents(): Promise<AgentEvent[]> {
    return Promise.resolve([...this.events]);
  }
}
