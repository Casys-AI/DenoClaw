import { useEffect, useRef, useState } from "preact/hooks";

interface ActivityEvent {
  id: number;
  time: string;
  type: string;
  agent?: string;
  detail: string;
  color: string;
}

function formatTime(): string {
  return new Date().toLocaleTimeString(
    "en-US",
    {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    } as Intl.DateTimeFormatOptions,
  );
}

function parseSSEEvent(
  data: Record<string, unknown>,
  counterRef: { current: number },
): ActivityEvent | null {
  const time = formatTime();

  switch (data.type) {
    case "snapshot": {
      const agents = data.agents as Array<{ agentId: string; status: string }>;
      return {
        id: ++counterRef.current,
        time,
        type: "snapshot",
        color: "badge-ghost",
        detail: `System snapshot: ${agents?.length ?? 0} agents`,
      };
    }
    case "agent_status": {
      const status = data.status as Record<string, unknown>;
      return {
        id: ++counterRef.current,
        time,
        type: "status",
        agent: data.agentId as string,
        color: status?.status === "running"
          ? "badge-success"
          : status?.status === "stopped"
          ? "badge-error"
          : "badge-info",
        detail: `Status → ${(status?.status as string) ?? "unknown"}`,
      };
    }
    case "agent_task": {
      const task = data.task as Record<string, unknown>;
      return {
        id: ++counterRef.current,
        time,
        type: "A2A",
        color: "badge-accent",
        agent: `${task?.from} → ${task?.to}`,
        detail: `${task?.status}: ${
          (task?.message as string)?.slice(0, 60) ?? ""
        }`,
      };
    }
    case "agents_list_updated": {
      const ids = data.agentIds as string[];
      return {
        id: ++counterRef.current,
        time,
        type: "registry",
        color: "badge-warning",
        detail: `Agents updated: ${ids?.join(", ")}`,
      };
    }
    case "keepalive":
      return null; // skip keepalives
    default:
      return {
        id: ++counterRef.current,
        time,
        type: data.type as string,
        color: "badge-ghost",
        detail: JSON.stringify(data).slice(0, 80),
      };
  }
}

const MAX_EVENTS = 500;

const FILTER_TYPES = ["All", "status", "A2A", "snapshot", "registry"] as const;

export default function ActivityFeed() {
  const [filter, setFilter] = useState<string>("All");
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const counterRef = useRef(0);

  useEffect(() => {
    // Connect via local proxy (same origin, no CORS)
    const es = new EventSource(`/api/events`);

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const event = parseSSEEvent(data, counterRef);
        if (!event) return;
        setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => es.close();
  }, []);

  const filtered = filter === "All"
    ? events
    : events.filter((e) => e.type === filter);

  return (
    <div>
      {/* Connection status + filters */}
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span
            class={`w-2 h-2 rounded-full ${
              connected ? "bg-success" : "bg-error"
            }`}
          />
          <span class="text-xs font-data text-neutral-content">
            {connected ? "Connected" : "Disconnected"} ·{" "}
            {filtered.length}/{events.length} events
          </span>
        </div>
        <div class="join">
          {FILTER_TYPES.map((t) => (
            <button
              type="button"
              key={t}
              class={`join-item btn btn-xs ${
                filter === t ? "btn-primary" : "btn-ghost"
              }`}
              onClick={() => setFilter(t)}
            >
              {t}
            </button>
          ))}
        </div>
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
            {filtered.length === 0
              ? (
                <tr>
                  <td colspan={4} class="text-neutral-content text-center py-8">
                    Waiting for events...
                  </td>
                </tr>
              )
              : (
                filtered.map((ev) => (
                  <tr key={ev.id} class="hover">
                    <td class="text-neutral-content">{ev.time}</td>
                    <td>
                      <span class={`badge badge-xs ${ev.color}`}>
                        {ev.type}
                      </span>
                    </td>
                    <td class="text-base-content">{ev.agent ?? "—"}</td>
                    <td class="text-neutral-content truncate max-w-md">
                      {ev.detail}
                    </td>
                  </tr>
                ))
              )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
