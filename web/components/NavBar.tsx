import { isNavItemActive } from "../lib/dashboard_ui.ts";

const NAV_ITEMS = [
  { href: "overview", label: "Overview" },
  { href: "network", label: "Network" },
  { href: "agents", label: "Agents" },
  { href: "a2a", label: "A2A" },
  { href: "cron", label: "Cron" },
  { href: "tunnels", label: "Tunnels" },
  { href: "cost", label: "Cost" },
  { href: "activity", label: "Activity" },
] as const;

export function NavBar({ currentPath }: { currentPath: string }) {
  return (
    <div class="navbar bg-base-200 px-4">
      <div class="navbar-start">
        <a
          href="overview"
          class="btn btn-ghost font-display text-xl font-bold tracking-tight gap-2"
        >
          <img src="logo.png" alt="DenoClaw" class="w-8 h-8" />
          DenoClaw
        </a>
      </div>
      <div class="navbar-center hidden md:flex">
          <ul class="menu menu-horizontal gap-1 px-1">
            {NAV_ITEMS.map((item) => {
              const isActive = isNavItemActive(currentPath, item.href);
              return (
                <li key={item.href}>
                <a
                  href={item.href}
                  class={isActive
                    ? "active nav-active font-medium"
                    : "text-neutral-content"}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      <div class="navbar-end">
        <div class="dropdown md:hidden mr-2">
          <label tabindex={0} class="btn btn-ghost">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </label>
          <ul
            tabindex={0}
            class="menu menu-sm dropdown-content mt-3 z-[1] p-2 shadow bg-base-200 w-52"
          >
            {NAV_ITEMS.map((item) => {
              const isActive = isNavItemActive(currentPath, item.href);
              return (
                <li key={item.href}>
                  <a
                    href={item.href}
                    class={isActive ? "active nav-active font-medium" : ""}
                  >
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
        <div class="flex items-center gap-2 px-3">
          <span class="w-2 h-2 rounded-full gradient-deno pulse-live" />
          <span class="text-xs font-data text-primary">LIVE</span>
        </div>
      </div>
    </div>
  );
}
