function configuredDashboardBasePath(): string {
  const rawBasePath = Deno.env.get("DENOCLAW_DASHBOARD_BASE_PATH") ?? "/ui";
  if (!rawBasePath || rawBasePath === "/") return "";
  return rawBasePath.endsWith("/") ? rawBasePath.slice(0, -1) : rawBasePath;
}

export function getDashboardBasePath(pathname: string): string {
  const dashboardBasePath = configuredDashboardBasePath();
  if (!dashboardBasePath) return "";

  return pathname === dashboardBasePath ||
      pathname.startsWith(`${dashboardBasePath}/`)
    ? dashboardBasePath
    : "";
}

export function stripDashboardBasePath(pathname: string): string {
  const basePath = getDashboardBasePath(pathname);
  if (!basePath) return pathname || "/";

  const stripped = pathname.slice(basePath.length);
  return stripped === "" ? "/" : stripped;
}
