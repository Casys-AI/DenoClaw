import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import {
  clearDashboardTokenCookies,
  getDashboardRequestConfig,
  getSafeDashboardRedirectTarget,
  setDashboardTokenCookies,
  validateTokenLoginInput,
} from "../lib/dashboard-auth.ts";
import type { DashboardAuthMode } from "../lib/dashboard-auth.ts";

interface LoginData {
  authMode: DashboardAuthMode;
  error: string | null;
  next: string;
  brokerUrl: string;
  githubConfigured: boolean;
}

function buildLoginData(
  req: Request,
  error: string | null,
): LoginData {
  const config = getDashboardRequestConfig(req);
  const url = new URL(req.url);

  return {
    authMode: config.authMode,
    error,
    next: getSafeDashboardRedirectTarget(url.searchParams.get("next"), config),
    brokerUrl: config.brokerUrl,
    githubConfigured: Boolean(
      Deno.env.get("GITHUB_CLIENT_ID") && Deno.env.get("GITHUB_CLIENT_SECRET"),
    ),
  };
}

export const handler = {
  GET(ctx: FreshContext) {
    const config = getDashboardRequestConfig(ctx.req);
    const url = new URL(ctx.req.url);
    const next = getSafeDashboardRedirectTarget(
      url.searchParams.get("next"),
      config,
    );

    if (config.authMode === "local-open") {
      return Response.redirect(new URL(config.overviewPath, url.origin), 302);
    }

    if (config.hasSession) {
      return Response.redirect(new URL(next, url.origin), 302);
    }

    return page(buildLoginData(ctx.req, url.searchParams.get("error")));
  },

  async POST(ctx: FreshContext) {
    const config = getDashboardRequestConfig(ctx.req);

    if (config.authMode !== "token") {
      return new Response("Token login is disabled for this dashboard.", {
        status: 405,
      });
    }

    const form = await ctx.req.formData();
    const brokerUrl = validateTokenLoginInput(form.get("brokerUrl"));
    if (!brokerUrl) {
      return page(buildLoginData(ctx.req, "Invalid broker URL."), {
        status: 400,
      });
    }

    const token = typeof form.get("token") === "string"
      ? form.get("token")!.toString().trim()
      : "";
    const next = getSafeDashboardRedirectTarget(
      typeof form.get("next") === "string"
        ? form.get("next")!.toString()
        : null,
      config,
    );

    const headers = new Headers({ location: next });
    clearDashboardTokenCookies(ctx.req, headers);
    setDashboardTokenCookies(ctx.req, headers, brokerUrl, token);

    return new Response(null, { status: 303, headers });
  },
};

export default function Login({ data }: { data: LoginData }) {
  const modeLabel = data.authMode === "token"
    ? "Manual token login"
    : "GitHub OAuth";

  return (
    <div class="min-h-screen bg-base-300 flex items-center justify-center px-4">
      <div class="card bg-base-200 w-full max-w-sm shadow-xl">
        <div class="card-body items-center text-center">
          <img src="logo.png" alt="DenoClaw" class="w-20 h-20 mb-2" />
          <h1 class="font-display text-2xl font-bold tracking-tight">
            DenoClaw
          </h1>
          <p class="text-sm text-neutral-content mb-1">
            Agent Orchestration Dashboard
          </p>
          <p class="text-xs font-data uppercase tracking-wider text-neutral-content mb-4">
            {modeLabel}
          </p>

          {data.error && (
            <div role="alert" class="alert alert-error mb-4 text-sm w-full">
              <span>{data.error}</span>
            </div>
          )}

          {data.authMode === "token"
            ? (
              <form class="w-full space-y-4" method="POST">
                <input type="hidden" name="next" value={data.next} />
                <div class="form-control w-full">
                  <label class="label">
                    <span class="label-text text-xs font-data uppercase tracking-wider">
                      Instance URL
                    </span>
                  </label>
                  <input
                    type="url"
                    name="brokerUrl"
                    placeholder="https://broker.example.com"
                    class="input input-bordered w-full font-data text-sm"
                    value={data.brokerUrl}
                    required
                  />
                </div>
                <div class="form-control w-full">
                  <label class="label">
                    <span class="label-text text-xs font-data uppercase tracking-wider">
                      API Token
                    </span>
                  </label>
                  <input
                    type="password"
                    name="token"
                    placeholder="Optional bearer token"
                    class="input input-bordered w-full font-data text-sm"
                  />
                </div>
                <button
                  type="submit"
                  class="btn w-full gradient-deno text-white border-none"
                >
                  Connect
                </button>
              </form>
            )
            : (
              <div class="w-full space-y-4">
                <p class="text-sm text-neutral-content">
                  Continue with GitHub to access the deployed dashboard.
                </p>
                <a
                  href="/auth/github"
                  class="btn btn-outline w-full gap-2"
                >
                  <svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  Sign in with GitHub
                </a>
                {!data.githubConfigured && (
                  <div role="alert" class="alert alert-warning text-sm">
                    <span>
                      GitHub OAuth is not configured yet on this deployment.
                    </span>
                  </div>
                )}
              </div>
            )}

          <p class="text-xs text-neutral-content mt-4">
            v0.1.0 — Powered by Deno
          </p>
        </div>
      </div>
    </div>
  );
}
