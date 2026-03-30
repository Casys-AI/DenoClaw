export type DashboardAuthMode = "local-open" | "token" | "github-oauth";

export function getDashboardAuthMode(): DashboardAuthMode {
  const raw = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
  if (raw) {
    const value = raw.trim().toLowerCase();
    if (value === "token") return "token";
    if (value === "github" || value === "github-oauth" || value === "oauth") {
      return "github-oauth";
    }
  }
  return Deno.env.get("DENO_DEPLOYMENT_ID") ? "github-oauth" : "local-open";
}

export function getDashboardAllowedUsers(): string[] | undefined {
  const raw = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS") ??
    Deno.env.get("GITHUB_ALLOWED_USERS");
  if (!raw) return undefined;
  const users = raw.split(",").map((user) => user.trim()).filter(Boolean);
  return users.length > 0 ? users : undefined;
}
