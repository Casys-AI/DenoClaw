import type { InstanceData } from "../lib/api-client.ts";

interface Props {
  instances: InstanceData[];
  selected?: string; // instance name, or "all"
  basePath?: string;
}

/** Horizontal instance selector bar — DaisyUI tabs. */
export function InstanceSelector(
  { instances, selected = "all", basePath = "" }: Props,
) {
  if (instances.length <= 1) return null;
  const normalizedBasePath = basePath.startsWith("/")
    ? basePath.slice(1)
    : basePath;

  return (
    <div role="tablist" class="tabs tabs-box bg-base-200">
      <a
        role="tab"
        href={`${normalizedBasePath}?instance=all`}
        class={`tab font-data text-xs ${
          selected === "all" ? "tab-active" : ""
        }`}
      >
        All Instances
        <span class="badge badge-xs badge-neutral ml-1">
          {instances.reduce((s, i) => s + i.agents.length, 0)}
        </span>
      </a>
      {instances.map((inst) => (
        <a
          key={inst.instance.name}
          role="tab"
          href={`${normalizedBasePath}?instance=${inst.instance.name}`}
          class={`tab font-data text-xs ${
            selected === inst.instance.name ? "tab-active" : ""
          }`}
        >
          <span
            class={`w-2 h-2 rounded-full mr-1 ${
              inst.reachable ? "bg-success" : "bg-error"
            }`}
          />
          {inst.instance.name}
          <span class="badge badge-xs badge-neutral ml-1">
            {inst.agents.length}
          </span>
        </a>
      ))}
    </div>
  );
}
