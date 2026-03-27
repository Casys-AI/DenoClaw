import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";

interface ActivityEvent {
  id: number;
  time: string;
  type: string;
  agent?: string;
  detail: string;
  color: string;
}

const events = signal<ActivityEvent[]>([]);
const connected = signal(false);
let eventCounter = 0;

function formatTime(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
}

function parseSSEEvent(data: Record<string, unknown>): ActivityEvent | null {
  const time = formatTime();

  switch (data.type) {
    case "snapshot": {
      const agents = data.agents as Array<{ agentId: string; status: string }>;
      return {
        id: ++eventCounter, time, type: "snapshot", color: "badge-ghost",
        detail: `System snapshot: ${agents?.length ?? 0} agents`,
      };
    }
    case "agent_status": {
      const status = data.status as Record<string, unknown>;
      return {
        id: ++eventCounter, time, type: "status", agent: data.agentId as string,
        color: status?.status === "running" ? "badge-success" : status?.status === "stopped" ? "badge-error" : "badge-info",
        detail: `Status → ${(status?.status as string) ?? "unknown"}`,
      };
    }
    case "agent_task": {
      const task = data.task as Record<string, unknown>;
      return {
        id: ++eventCounter, time, type: "A2A", color: "badge-accent",
        agent: `${task?.from} → ${task?.to}`,
        detail: `${task?.status}: ${(task?.message as string)?.slice(0, 60) ?? ""}`,
      };
    }
    case "agents_list_updated": {
      const ids = data.agentIds as string[];
      return {
        id: ++eventCounter, time, type: "registry", color: "badge-warning",
        detail: `Agents updated: ${ids?.join(", ")}`,
      };
    }
    case "keepalive":
      return null; // skip keepalives
    default:
      return {
        id: ++eventCounter, time, type: data.type as string, color: "badge-ghost",
        detail: JSON.stringify(data).slice(0, 80),
      };
  }
}

const MAX_EVENTS = 500;

export default function ActivityFeed({ brokerUrl: _brokerUrl }: { brokerUrl: string }) {
  useEffect(() => {
    // Connect via local proxy (same origin, no CORS)
    const es = new EventSource(`/api/events`);

    es.onopen = () => { connected.value = true; };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const event = parseSSEEvent(data);
        if (!event) return;
        events.value = [event, ...events.value].slice(0, MAX_EVENTS);
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      connected.value = false;
    };

    return () => es.close();
  }, []);

  return (
    <div>
      {/* Connection status */}
      <div class="flex items-center gap-2 mb-3">
        <span class={`w-2 h-2 rounded-full ${connected.value ? "bg-success" : "bg-error"}`} />
        <span class="text-xs font-data text-neutral-content">
          {connected.value ? "Connected" : "Disconnected"} · {events.value.length} events
        </span>
      </div>

      {/* Event table */}
      <div class="overflow-y-auto max-h-[70vh]">
        <table class="table table-xs w-full">
          <thead>
            <tr class="text-neutral-content font-data text-xs uppercase">
              <th class="w-28">Time</th>
              <th class="w-20">Type</th>
              <th class="w-28">Agent</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody class="font-data text-xs">
            {events.value.length === 0 ? (
              <tr>
                <td colspan={4} class="text-neutral-content text-center py-8">
                  Waiting for events...
                </td>
              </tr>
            ) : (
              events.value.map((ev) => (
                <tr key={ev.id} class="hover">
                  <td class="text-neutral-content">{ev.time}</td>
                  <td><span class={`badge badge-xs ${ev.color}`}>{ev.type}</span></td>
                  <td class="text-base-content">{ev.agent ?? "—"}</td>
                  <td class="text-neutral-content truncate max-w-md">{ev.detail}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
