import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getAllInstancesData, type InstanceData } from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import { InstanceSelector } from "../components/InstanceSelector.tsx";
import { StatusDot } from "../components/StatusBadge.tsx";
import type { AgentStatusEntry, HealthResponse } from "../lib/types.ts";
import NetworkGraph from "../islands/NetworkGraph.tsx";
import { formatCompact, formatLatency } from "../lib/format.ts";

interface NetworkData {
  instances: InstanceData[];
  agents: AgentStatusEntry[];
  health: HealthResponse | null;
  selectedInstance: string;
  brokerUrl: string;
  federationSuccess: number;
  federationErrors: number;
  federationP95LatencyMs: number;
  federationDeadLetters: number;
  federationReportingCount: number;
  federationExpectedCount: number;
}

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const dashboard = getDashboardRequestConfig(ctx.req);
    const selectedInstance = ctx.url.searchParams.get("instance") || "all";
    const instances = await getAllInstancesData({
      instances: dashboard.instances,
      token: dashboard.token,
      includeFederation: true,
    });

    const filteredInstances = selectedInstance === "all"
      ? instances
      : instances.filter((i) => i.instance.name === selectedInstance);

    const agents = filteredInstances.flatMap((i) => i.agents);
    const tunnels = filteredInstances.flatMap((i) => i.health?.tunnels ?? []);
    const mergedHealth: HealthResponse = {
      status: "ok",
      tunnels,
      tunnelCount: tunnels.length,
    };
    const federationSuccess = filteredInstances.reduce(
      (sum, instance) => sum + (instance.federation?.successCount ?? 0),
      0,
    );
    const federationErrors = filteredInstances.reduce(
      (sum, instance) => sum + (instance.federation?.errorCount ?? 0),
      0,
    );
    const federationDeadLetters = filteredInstances.reduce(
      (sum, instance) => sum + (instance.federation?.deadLetterBacklog ?? 0),
      0,
    );
    const federationReportingCount = filteredInstances.filter(
      (instance) => instance.federation !== null,
    ).length;
    const federationExpectedCount = filteredInstances.length;
    const federationP95LatencyMs = Math.max(
      0,
      ...filteredInstances.flatMap(
        (instance) =>
          instance.federation?.links.map((link) => link.p95LatencyMs) ?? [],
      ),
    );

    return page({
      instances,
      agents,
      health: mergedHealth,
      selectedInstance,
      brokerUrl: instances[0]?.instance.url ?? dashboard.brokerUrl,
      federationSuccess,
      federationErrors,
      federationP95LatencyMs,
      federationDeadLetters,
      federationReportingCount,
      federationExpectedCount,
    } as NetworkData);
  },
};

export default function Network({ data }: { data: NetworkData }) {
  const {
    instances,
    agents,
    health,
    selectedInstance,
    brokerUrl,
    federationSuccess,
    federationErrors,
    federationP95LatencyMs,
    federationDeadLetters,
    federationReportingCount,
    federationExpectedCount,
  } = data;
  const tunnels = health?.tunnels ?? [];
  const hasFederation = federationReportingCount > 0;
  const federationCoverageText =
    federationReportingCount === federationExpectedCount
      ? `${formatCompact(federationErrors)} errors`
      : `${
        formatCompact(federationErrors)
      } errors · ${federationReportingCount}/${federationExpectedCount} brokers reporting`;
  const federationBacklogText =
    federationReportingCount === federationExpectedCount
      ? `dead-letter: ${formatCompact(federationDeadLetters)}`
      : `dead-letter: ${
        formatCompact(federationDeadLetters)
      } · partial coverage`;

  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Network Topology</h1>

      <InstanceSelector
        instances={instances}
        selected={selectedInstance}
        basePath="/network"
      />

      <div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Graph — 3/4 */}
        <div class="lg:col-span-3 card bg-base-200">
          <div class="card-body p-4">
            <NetworkGraph
              agents={agents}
              tunnels={tunnels}
              brokerUrl={brokerUrl}
            />
          </div>
        </div>

        {/* Sidebar — 1/4 */}
        <div class="space-y-4">
          <div class="stats stats-vertical w-full bg-base-200">
            <div class="stat">
              <div class="stat-title">Agents</div>
              <div class="stat-value font-data text-lg">{agents.length}</div>
            </div>
            <div class="stat">
              <div class="stat-title">Tunnels</div>
              <div class="stat-value font-data text-lg">{tunnels.length}</div>
            </div>
            <div class="stat">
              <div class="stat-title">Federation Success</div>
              <div
                class={`stat-value font-data ${
                  hasFederation
                    ? "text-success text-lg"
                    : "text-warning text-base"
                }`}
              >
                {hasFederation
                  ? formatCompact(federationSuccess)
                  : "unavailable"}
              </div>
              <div class="stat-desc">
                {hasFederation
                  ? federationCoverageText
                  : "stats endpoint unavailable"}
              </div>
            </div>
            <div class="stat">
              <div class="stat-title">Worst Link P95</div>
              <div
                class={`stat-value font-data ${
                  hasFederation ? "text-lg" : "text-base text-warning"
                }`}
              >
                {hasFederation
                  ? formatLatency(federationP95LatencyMs)
                  : "unavailable"}
              </div>
              <div class="stat-desc">
                {hasFederation
                  ? federationBacklogText
                  : "stats endpoint unavailable"}
              </div>
            </div>
          </div>
          <div class="card bg-base-200">
            <div class="card-body p-4">
              <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
                Agents
              </h3>
              {agents.length === 0
                ? (
                  <div role="alert" class="alert alert-info">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      class="stroke-current w-6 h-6 shrink-0"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>
                      No agents found. Configure agents with{" "}
                      <code class="font-data">denoclaw agent create</code>.
                    </span>
                  </div>
                )
                : (
                  <ul class="space-y-2">
                    {agents.map((agent) => (
                      <li
                        key={agent.agentId}
                        class="flex items-center justify-between"
                      >
                        <a
                          href={`agents/${agent.agentId}`}
                          class="link link-primary text-sm"
                        >
                          {agent.agentId}
                        </a>
                        <StatusDot status={agent.status} />
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>
        </div>
      </div>

      <div class="text-xs font-data text-neutral-content">
        {agents.length} agents · {tunnels.length} tunnels
      </div>
    </div>
  );
}
