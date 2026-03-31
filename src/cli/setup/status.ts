import type { Config } from "../../config/types.ts";
import { output } from "../output.ts";
import { print } from "../prompt.ts";

export async function showStatus(config: Config): Promise<void> {
  print("\n=== DenoClaw Status ===\n");

  const providers = Object.entries(config.providers)
    .filter(([_, value]) => value?.apiKey || value?.enabled)
    .map(([key, value]) => `${key}${value?.apiKey ? " (key)" : " (no-key)"}`);

  print(`Providers    : ${providers.join(", ") || "none"}`);
  print(`Model        : ${config.agents.defaults.model}`);
  print(`Temperature  : ${config.agents.defaults.temperature}`);
  print(`Max tokens   : ${config.agents.defaults.maxTokens}`);

  const channels = Object.entries(config.channels)
    .filter(([_, value]) => value && "enabled" in value && value.enabled)
    .map(([key]) => key);
  const routeScopes = config.channels.routing?.scopes ?? [];
  print(`Channels     : ${channels.join(", ") || "none"}`);
  print(`Route scopes : ${routeScopes.length}`);

  print(
    `Workspace    : ${
      config.tools.restrictToWorkspace ? "restricted" : "unrestricted"
    }`,
  );

  try {
    const { SessionManager } = await import("../../messaging/session.ts");
    const sm = new SessionManager();
    const sessions = await sm.getActive();
    print(`Sessions     : ${sessions.length} active(s)`);
    sm.close();
  } catch {
    print("Sessions     : KV unavailable");
  }

  const deploy = config.deploy;
  if (deploy?.url) {
    const brokerUrl = deploy.url;
    const token = Deno.env.get("DENOCLAW_API_TOKEN");
    print(`\n── Remote Broker ──\n`);
    print(`URL          : ${brokerUrl}`);

    if (token) {
      try {
        const res = await fetch(`${brokerUrl}/health`, {
          headers: { "Authorization": `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const health = await res.json() as { tunnelCount?: number };
          print("Status       : online");
          print(`Tunnels      : ${health.tunnelCount ?? 0}`);
        } else {
          print(`Status       : error (${res.status})`);
        }
      } catch {
        print("Status       : unreachable");
      }
    } else {
      print("Status       : no token (set DENOCLAW_API_TOKEN)");
    }
  } else if (deploy?.app) {
    print(`\n── Remote Broker ──\n`);
    print(`App          : ${deploy.app}`);
    print(
      "URL          : not configured (set deploy.url or DENOCLAW_BROKER_URL)",
    );
  }

  print("");

  output({
    providers,
    model: config.agents.defaults.model,
    channels,
    routeScopes: routeScopes.length,
    deploy: deploy ?? null,
  });
}
