const BASE = Deno.env.get("DENOCLAW_DASHBOARD_BASE") || "";

const NAV_ITEMS = [
  { href: `${BASE}/overview`, label: "Overview" },
  { href: `${BASE}/network`, label: "Network" },
  { href: `${BASE}/agents`, label: "Agents" },
  { href: `${BASE}/a2a`, label: "A2A" },
  { href: `${BASE}/cost`, label: "Cost" },
  { href: `${BASE}/activity`, label: "Activity" },
];

export function NavBar({ currentPath }: { currentPath: string }) {
  return (
    <div class="navbar bg-base-200 px-4">
      <div class="navbar-start">
        <a href={`${BASE}/overview`} class="btn btn-ghost font-display text-xl font-bold tracking-tight gap-2">
          <img src="/logo.png" alt="DenoClaw" class="w-8 h-8" />
          DenoClaw
        </a>
      </div>
      <div class="navbar-center">
        <ul class="menu menu-horizontal gap-1 px-1">
          {NAV_ITEMS.map((item) => {
            const isActive = currentPath === item.href || currentPath.startsWith(item.href + "/");
            return (
              <li key={item.href}>
                <a
                  href={item.href}
                  class={isActive ? "active nav-active font-medium" : "text-neutral-content"}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      <div class="navbar-end">
        <div class="flex items-center gap-2 px-3">
          <span class="w-2 h-2 rounded-full gradient-deno pulse-live" />
          <span class="text-xs font-data text-primary">LIVE</span>
        </div>
      </div>
    </div>
  );
}
