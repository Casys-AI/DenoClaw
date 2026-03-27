import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import type { AgentStatusEntry } from "../lib/types.ts";

/** Shared signals — all islands subscribe to these. */
export const agentStatuses = signal<AgentStatusEntry[]>([]);
export const connected = signal(false);

interface EventStreamProps {
  brokerUrl: string;
}

/**
 * EventStream island — singleton SSE connection manager.
 * Mount once in _app.tsx. Manages SSE connection to broker/gateway,
 * updates shared Preact signals that other islands subscribe to.
 */
export default function EventStream({ brokerUrl }: EventStreamProps) {
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: number | undefined;

    function connect() {
      // Connect via local proxy (same origin, no CORS)
      es = new EventSource(`/api/events`);

      es.onopen = () => {
        connected.value = true;
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);

          switch (event.type) {
            case "snapshot":
              agentStatuses.value = event.agents;
              break;

            case "agent_status": {
              const updated = agentStatuses.value.map((a) =>
                a.agentId === event.agentId ? { ...a, ...event.status } : a
              );
              // Add if new agent
              if (!updated.find((a) => a.agentId === event.agentId)) {
                updated.push({ agentId: event.agentId, ...event.status });
              }
              agentStatuses.value = updated;
              break;
            }

            case "agents_list_updated":
              // Refetch full agent list
              fetch(`${brokerUrl}/agents`)
                .then((r) => r.json())
                .then((agents) => { agentStatuses.value = agents; })
                .catch(() => {});
              break;

            case "keepalive":
              break;
          }
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        connected.value = false;
        es?.close();
        // Reconnect after 3s
        reconnectTimer = setTimeout(connect, 3000) as unknown as number;
      };
    }

    connect();

    return () => {
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [brokerUrl]);

  return (
    <div class="fixed bottom-4 right-4">
      <span class={`badge badge-sm ${connected.value ? "badge-success" : "badge-error"}`}>
        {connected.value ? "Live" : "Disconnected"}
      </span>
    </div>
  );
}
