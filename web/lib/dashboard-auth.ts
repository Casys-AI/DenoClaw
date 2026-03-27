import { getDashboardBasePath } from "./base-path.ts";
import { getInstances, type Instance } from "./instances.ts";

export type DashboardAuthMode = "local-open" | "token" | "github-oauth";

export const DASHBOARD_GITHUB_SESSION_COOKIE = "denoclaw_session";
export const DASHBOARD_BROKER_COOKIE = "denoclaw_broker_url";
export const DASHBOARD_TOKEN_COOKIE = "denoclaw_token";

const DEFAULT_BROKER_URL = "http://localhost:3000";

export interface DashboardRequestConfig {
  authMode: DashboardAuthMode;
  basePath: string;
  overviewPath: string;
  loginPath: string;
  brokerUrl: string;
  token: string;
  instances: Instance[];
  hasSession: boolean;
}

function normalizeAuthMode(value?: string | null): DashboardAuthMode {
  switch (value?.trim().toLowerCase()) {
    case "token":
      return "token";
    case "github":
    case "github-oauth":
    case "oauth":
      return "github-oauth";
    case "local":
    case "local-open":
    default:
      return "local-open";
  }
}

function parseCookies(req: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return cookies;

  for (const entry of cookieHeader.split(";")) {
    const [name, ...valueParts] = entry.trim().split("=");
    if (!name || valueParts.length === 0) continue;
    const rawValue = valueParts.join("=");
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }

  return cookies;
}

function normalizeBrokerUrl(value?: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalized = url.toString().replace(/\/$/, "");
    return normalized;
  } catch {
    return null;
  }
}

function isSecureRequest(req: Request): boolean {
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

function serializeCookie(
  name: string,
  value: string,
  req: Request,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function defaultInstances(req: Request): Instance[] {
  const configuredBrokerUrls = Deno.env.get("DENOCLAW_BROKER_URLS");
  const configuredBrokerUrl = Deno.env.get("DENOCLAW_BROKER_URL");
  if (configuredBrokerUrls || configuredBrokerUrl) {
    const instances = getInstances();
    return instances.length > 0
      ? instances
      : [{ name: "local", url: DEFAULT_BROKER_URL }];
  }

  const url = new URL(req.url);
  const basePath = getDashboardBasePath(url.pathname);
  if (basePath) {
    return [{ name: "local", url: url.origin }];
  }

  return [{ name: "local", url: DEFAULT_BROKER_URL }];
}

export function getDashboardAuthMode(): DashboardAuthMode {
  const explicitMode = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
  if (explicitMode) return normalizeAuthMode(explicitMode);

  return Deno.env.get("DENO_DEPLOYMENT_ID")
    ? "github-oauth"
    : "local-open";
}

export function getDashboardAllowedUsers(): string[] | undefined {
  const raw = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS") ??
    Deno.env.get("GITHUB_ALLOWED_USERS");
  if (!raw) return undefined;

  const users = raw.split(",").map((user) => user.trim()).filter(Boolean);
  return users.length > 0 ? users : undefined;
}

export function getDashboardRequestConfig(req: Request): DashboardRequestConfig {
  const url = new URL(req.url);
  const basePath = getDashboardBasePath(url.pathname);
  const authMode = getDashboardAuthMode();
  const cookies = parseCookies(req);
  const instances = defaultInstances(req);
  const envBrokerUrl = instances[0]?.url ?? DEFAULT_BROKER_URL;
  const cookieBrokerUrl = normalizeBrokerUrl(
    cookies.get(DASHBOARD_BROKER_COOKIE),
  );
  const cookieToken = cookies.get(DASHBOARD_TOKEN_COOKIE) ?? "";
  const hasGitHubSession = Boolean(
    cookies.get(DASHBOARD_GITHUB_SESSION_COOKIE),
  );
  const hasTokenSession = Boolean(cookieBrokerUrl);
  const brokerUrl = authMode === "token"
    ? cookieBrokerUrl ?? envBrokerUrl
    : envBrokerUrl;
  const token = authMode === "token"
    ? cookieToken
    : Deno.env.get("DENOCLAW_API_TOKEN") ?? "";

  return {
    authMode,
    basePath,
    overviewPath: joinDashboardPath(basePath, "/overview"),
    loginPath: joinDashboardPath(basePath, "/login"),
    brokerUrl,
    token,
    instances: authMode === "token"
      ? [{ name: "remote", url: brokerUrl }]
      : instances,
    hasSession: authMode === "local-open"
      ? true
      : authMode === "token"
      ? hasTokenSession
      : hasGitHubSession,
  };
}

export function joinDashboardPath(basePath: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return basePath ? `${basePath}${normalizedPath}` : normalizedPath;
}

export function getSafeDashboardRedirectTarget(
  next: string | null,
  config: DashboardRequestConfig,
): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return config.overviewPath;
  }

  return next;
}

export function createDashboardLoginRedirect(req: Request): Response {
  const config = getDashboardRequestConfig(req);
  const url = new URL(req.url);
  const location = new URL(config.loginPath, url.origin);
  const next = `${url.pathname}${url.search}`;

  if (next !== config.loginPath) {
    location.searchParams.set("next", next);
  }

  return Response.redirect(location.toString(), 302);
}

export function requireDashboardSession(req: Request): Response | null {
  const config = getDashboardRequestConfig(req);
  if (config.hasSession) return null;
  return createDashboardLoginRedirect(req);
}

export function setDashboardTokenCookies(
  req: Request,
  headers: Headers,
  brokerUrl: string,
  token: string,
): void {
  headers.append(
    "Set-Cookie",
    serializeCookie(DASHBOARD_BROKER_COOKIE, brokerUrl, req, 30 * 24 * 60 * 60),
  );
  headers.append(
    "Set-Cookie",
    serializeCookie(DASHBOARD_TOKEN_COOKIE, token, req, 30 * 24 * 60 * 60),
  );
}

export function clearDashboardTokenCookies(
  req: Request,
  headers: Headers,
): void {
  headers.append(
    "Set-Cookie",
    serializeCookie(DASHBOARD_BROKER_COOKIE, "", req, 0),
  );
  headers.append(
    "Set-Cookie",
    serializeCookie(DASHBOARD_TOKEN_COOKIE, "", req, 0),
  );
}

export function validateTokenLoginInput(
  brokerUrl: FormDataEntryValue | null,
): string | null {
  if (typeof brokerUrl !== "string") return null;
  return normalizeBrokerUrl(brokerUrl);
}
