const DASHBOARD_BASE_PATH = "/ui";

export function getDashboardBasePath(pathname: string): string {
  return pathname === DASHBOARD_BASE_PATH ||
      pathname.startsWith(`${DASHBOARD_BASE_PATH}/`)
    ? DASHBOARD_BASE_PATH
    : "";
}

export function stripDashboardBasePath(pathname: string): string {
  const basePath = getDashboardBasePath(pathname);
  if (!basePath) return pathname || "/";

  const stripped = pathname.slice(basePath.length);
  return stripped === "" ? "/" : stripped;
}
