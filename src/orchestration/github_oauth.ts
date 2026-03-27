/**
 * GitHub OAuth2 web flow for dashboard authentication.
 *
 * Flow: /auth/github → GitHub authorize → /auth/github/callback → session cookie
 * Requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET env vars.
 */

import { log } from "../shared/log.ts";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const SESSION_COOKIE = "denoclaw_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
}

interface DashboardSession {
  user: GitHubUser;
  createdAt: string;
  expiresAt: string;
}

export class GitHubOAuth {
  private clientId: string;
  private clientSecret: string;
  private kv: Deno.Kv;
  private allowedUsers?: string[];

  constructor(kv: Deno.Kv, allowedUsers?: string[]) {
    this.clientId = Deno.env.get("GITHUB_CLIENT_ID") ?? "";
    this.clientSecret = Deno.env.get("GITHUB_CLIENT_SECRET") ?? "";
    this.kv = kv;
    this.allowedUsers = allowedUsers;
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** Start OAuth flow — redirect to GitHub. */
  handleAuthorize(req: Request): Response {
    if (!this.isConfigured()) {
      return Response.json(
        {
          code: "OAUTH_NOT_CONFIGURED",
          recovery: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET",
        },
        { status: 500 },
      );
    }

    const url = new URL(req.url);
    const state = crypto.randomUUID();
    const callbackUrl = `${url.origin}/auth/github/callback`;

    // Store state in KV for CSRF protection
    this.kv.set(["oauth", "state", state], true, { expireIn: 300_000 }); // 5 min

    const authUrl = new URL(GITHUB_AUTHORIZE_URL);
    authUrl.searchParams.set("client_id", this.clientId);
    authUrl.searchParams.set("redirect_uri", callbackUrl);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("scope", "read:user");

    return Response.redirect(authUrl.toString(), 302);
  }

  /** Handle callback from GitHub — exchange code, create session. */
  async handleCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return this.errorRedirect(url.origin, "Missing code or state parameter");
    }

    // Verify CSRF state
    const stateEntry = await this.kv.get(["oauth", "state", state]);
    if (!stateEntry.value) {
      return this.errorRedirect(
        url.origin,
        "Invalid or expired state — try again",
      );
    }
    await this.kv.delete(["oauth", "state", state]);

    // Exchange code for access token
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
      }),
    });

    if (!tokenRes.ok) {
      log.error(`GitHub token exchange failed: ${tokenRes.status}`);
      return this.errorRedirect(url.origin, "GitHub token exchange failed");
    }

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      error?: string;
    };
    if (tokenData.error || !tokenData.access_token) {
      log.error(`GitHub OAuth error: ${tokenData.error}`);
      return this.errorRedirect(url.origin, `GitHub error: ${tokenData.error}`);
    }

    // Fetch user info
    const userRes = await fetch(GITHUB_USER_URL, {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      return this.errorRedirect(url.origin, "Failed to fetch GitHub user info");
    }

    const user = await userRes.json() as GitHubUser;

    // Check allowlist if configured
    if (this.allowedUsers?.length && !this.allowedUsers.includes(user.login)) {
      log.warn(`GitHub login denied for user: ${user.login}`);
      return this.errorRedirect(
        url.origin,
        `User '${user.login}' is not authorized`,
      );
    }

    // Create session
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const session: DashboardSession = {
      user: { login: user.login, id: user.id, avatar_url: user.avatar_url },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };

    await this.kv.set(["dashboard", "session", sessionId], session, {
      expireIn: SESSION_TTL_MS,
    });

    log.info(`Dashboard login: ${user.login}`);

    // Redirect to dashboard with session cookie
    const headers = new Headers({ "Location": "/ui/overview" });
    headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
        SESSION_TTL_MS / 1000
      }; Secure`,
    );

    return new Response(null, { status: 302, headers });
  }

  /** Verify a dashboard session from the cookie. Returns the user or null. */
  async verifySession(req: Request): Promise<GitHubUser | null> {
    const cookie = req.headers.get("cookie");
    if (!cookie) return null;

    const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (!match) return null;

    const sessionId = match[1];
    const entry = await this.kv.get<DashboardSession>([
      "dashboard",
      "session",
      sessionId,
    ]);
    if (!entry.value) return null;

    const expiry = new Date(entry.value.expiresAt);
    if (expiry < new Date()) {
      await this.kv.delete(["dashboard", "session", sessionId]);
      return null;
    }

    return entry.value.user;
  }

  /** Logout — clear session. */
  async handleLogout(req: Request): Promise<Response> {
    const cookie = req.headers.get("cookie");
    const match = cookie?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (match) {
      await this.kv.delete(["dashboard", "session", match[1]]);
    }

    const headers = new Headers({ "Location": "/ui/login" });
    headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
    );

    return new Response(null, { status: 302, headers });
  }

  private errorRedirect(origin: string, message: string): Response {
    const url = new URL("/ui/login", origin);
    url.searchParams.set("error", message);
    return Response.redirect(url.toString(), 302);
  }
}
