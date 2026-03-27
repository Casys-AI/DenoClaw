import { useEffect, useRef, useState } from "preact/hooks";
import { STATUS_COLORS } from "../components/StatusBadge.tsx";

interface Agent {
  agentId: string;
  status: string;
  model?: string;
  instance?: string;
}

interface NetworkGraphProps {
  agents: Agent[];
  tunnels: string[];
  brokerUrl: string;
}

// deno-lint-ignore no-explicit-any
const getCytoscape = (): any => (globalThis as any).cytoscape;

/** Hex colors for Cytoscape node styling (canvas rendering, not CSS classes). */
const CY_STATUS_COLORS: Record<string, string> = {
  running: "#22c55e",
  alive: "#3b82f6",
  stopped: "#ef4444",
};

export default function NetworkGraph(
  { agents, tunnels, brokerUrl: _brokerUrl }: NetworkGraphProps,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [cyLoaded, setCyLoaded] = useState(false);

  // Load Cytoscape via CDN
  useEffect(() => {
    if (typeof window !== "undefined" && !("cytoscape" in window)) {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.4/cytoscape.min.js";
      script.onload = () => setCyLoaded(true);
      document.head.appendChild(script);
    } else {
      setCyLoaded(true);
    }
  }, []);

  // Init graph
  useEffect(() => {
    if (!cyLoaded || !containerRef.current || !getCytoscape()) return;

    const cy = getCytoscape();
    const elements: Record<string, unknown>[] = [];

    // Broker node
    elements.push({
      data: { id: "broker", label: "Broker", type: "broker" },
    });

    // Agent nodes
    for (const agent of agents) {
      elements.push({
        data: {
          id: agent.agentId,
          label: agent.agentId,
          type: "agent",
          status: agent.status,
          model: agent.model ?? "",
          instance: agent.instance ?? "",
        },
      });
      // Edge agent → broker
      elements.push({
        data: { source: agent.agentId, target: "broker", type: "agent-broker" },
      });
    }

    // Tunnel nodes
    for (const tunnelId of tunnels) {
      elements.push({
        data: {
          id: `tunnel-${tunnelId}`,
          label: tunnelId.slice(0, 8),
          type: "tunnel",
        },
      });
      elements.push({
        data: {
          source: `tunnel-${tunnelId}`,
          target: "broker",
          type: "tunnel-broker",
        },
      });
    }

    const cyInstance = cy({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: "node[type='broker']",
          style: {
            "background-color": "#00C2FF",
            "label": "data(label)",
            "color": "#e5e5e5",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "font-size": 11,
            "font-family": "Inter, sans-serif",
            "width": 40,
            "height": 40,
            "shape": "hexagon",
          },
        },
        {
          selector: "node[type='agent']",
          style: {
            "background-color": "#22c55e",
            "label": "data(label)",
            "color": "#e5e5e5",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "font-size": 10,
            "font-family": "Inter, sans-serif",
            "width": 30,
            "height": 30,
          },
        },
        {
          selector: "node[type='tunnel']",
          style: {
            "background-color": "#333",
            "label": "data(label)",
            "color": "#888",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "font-size": 9,
            "font-family": "JetBrains Mono, monospace",
            "width": 24,
            "height": 24,
            "shape": "rectangle",
          },
        },
        {
          selector: "edge[type='agent-broker']",
          style: {
            "line-color": "#333",
            "width": 1,
            "curve-style": "bezier",
          },
        },
        {
          selector: "edge[type='tunnel-broker']",
          style: {
            "line-color": "#00C2FF",
            "width": 1.5,
            "line-style": "dashed",
            "curve-style": "bezier",
          },
        },
      ],
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: 8000,
        idealEdgeLength: 120,
        gravity: 0.3,
      },
      userZoomingEnabled: true,
      userPanningEnabled: true,
    });

    // Color agents by status
    for (const agent of agents) {
      const node = cyInstance.getElementById(agent.agentId);
      if (node) {
        node.style(
          "background-color",
          CY_STATUS_COLORS[agent.status] || "#666",
        );
      }
    }

    // Click handler
    cyInstance.on(
      "tap",
      "node[type='agent']",
      (evt: { target: { id: () => string; data: (k: string) => string } }) => {
        const id = evt.target.id();
        const agent = agents.find((a) => a.agentId === id);
        if (agent) setSelected(agent);
      },
    );

    cyInstance.on("tap", "node[type='broker']", () => setSelected(null));

    return () => cyInstance.destroy();
  }, [cyLoaded, agents, tunnels]);

  if (!cyLoaded) {
    return (
      <div class="flex items-center justify-center h-[460px]">
        <span class="loading loading-spinner loading-lg" />
      </div>
    );
  }

  return (
    <div class="flex gap-4">
      {/* Graph */}
      <div class="flex-1">
        <div
          ref={containerRef}
          class="bg-base-300 w-full"
          style={{ height: "460px" }}
        />
        {/* Legend */}
        <div class="flex gap-6 text-xs text-neutral-content mt-2">
          {(["running", "alive", "stopped"] as const).map((s) => (
            <div key={s} class="flex items-center gap-1">
              <span class={`w-3 h-3 rounded-full ${STATUS_COLORS[s]}`} />
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </div>
          ))}
          <div class="flex items-center gap-1">
            <span
              class="w-3 h-3 gradient-deno"
              style="clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)"
            />{" "}
            Broker
          </div>
          <div class="flex items-center gap-1">
            <span class="w-3 h-3 bg-neutral" /> Tunnel
          </div>
        </div>
      </div>

      {/* Sidebar */}
      {selected && (
        <div class="w-72 space-y-3">
          <div class="card bg-base-200">
            <div class="card-body p-4">
              <div class="flex items-center justify-between">
                <h3 class="font-display font-bold text-lg">
                  {selected.agentId}
                </h3>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  onClick={() => setSelected(null)}
                >
                  ✕
                </button>
              </div>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between">
                  <span class="text-neutral-content">Status</span>
                  <span
                    class={`badge badge-sm ${
                      selected.status === "running"
                        ? "badge-success"
                        : selected.status === "stopped"
                        ? "badge-error"
                        : "badge-info"
                    }`}
                  >
                    {selected.status}
                  </span>
                </div>
                {selected.model && (
                  <div class="flex justify-between">
                    <span class="text-neutral-content">Model</span>
                    <span class="font-data text-xs">{selected.model}</span>
                  </div>
                )}
                {selected.instance && (
                  <div class="flex justify-between">
                    <span class="text-neutral-content">Instance</span>
                    <span class="font-data text-xs">{selected.instance}</span>
                  </div>
                )}
              </div>
              <a
                href={`agents/${selected.agentId}`}
                class="btn btn-primary btn-sm mt-2"
              >
                View Details →
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
