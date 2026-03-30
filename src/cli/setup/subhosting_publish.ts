import type { AgentEntry } from "../../shared/types.ts";
import { getConfigOrDefault } from "../../config/mod.ts";
import { getDeployOrgToken } from "../../shared/deploy_credentials.ts";
import { ask, error, print, success } from "../prompt.ts";
import {
  buildDeployAssets,
  createDeployApiHeaders,
  createDeployEnvVars,
  deployAppRevision,
  ensureDeployApp,
  getDeployAppEndpoint,
  registerAgentEndpointWithBroker,
  resolveBrokerUrl,
} from "../deploy_api.ts";
import { requireInteractive } from "../output.ts";

export async function publishAgent(): Promise<void> {
  requireInteractive("denoclaw deploy agent");
  print("\n=== Publish an Agent App to Deno Deploy ===\n");

  const token = getDeployOrgToken() ??
    await ask("Deno Deploy organization access token");
  const agentName = await ask("Agent name", "denoclaw-agent-1");

  if (!token) {
    error("A Deno Deploy organization access token is required.");
    print(
      "  Create it from Settings > Access Tokens in the Deno Deploy dashboard",
    );
    return;
  }

  const config = await getConfigOrDefault();
  const model = config.agents.defaults.model;
  const sandboxPerms = config.agents.defaults.sandbox?.allowedPermissions ||
    ["read", "write", "run", "net"];
  const brokerUrl = resolveBrokerUrl(config) || await ask("Broker URL");
  const brokerOidcAudience = Deno.env.get("DENOCLAW_BROKER_OIDC_AUDIENCE") ||
    config.deploy?.oidcAudience ||
    brokerUrl;
  const brokerToken = Deno.env.get("DENOCLAW_API_TOKEN") ||
    await ask("Broker token (empty = rely on OIDC / unauthenticated broker)");

  print(`  Agent: ${agentName}`);
  print(`  Model: ${model}`);
  print(`  Sandbox permissions: ${sandboxPerms.join(", ")}`);
  print(`  Broker URL: ${brokerUrl}`);

  const headers = createDeployApiHeaders(token);

  try {
    print("\n1. Ensuring the Deploy app exists...");
    const app = await ensureDeployApp(agentName, headers);
    print("2. Deploying AgentRuntime...");

    const entry: AgentEntry = {
      model,
      sandbox: { allowedPermissions: sandboxPerms },
    };
    const entrypoint = generateAgentEntrypoint(agentName, entry);
    const assets = await buildDeployAssets(entrypoint);
    const envVars = createDeployEnvVars({
      DENOCLAW_AGENT_ID: agentName,
      DENOCLAW_BROKER_URL: brokerUrl,
      ...(brokerOidcAudience && brokerOidcAudience !== brokerUrl
        ? { DENOCLAW_BROKER_OIDC_AUDIENCE: brokerOidcAudience }
        : {}),
      ...(brokerToken ? { DENOCLAW_API_TOKEN: brokerToken } : {}),
    });

    const revision = await deployAppRevision({
      app,
      assets,
      envVars,
      headers,
    });
    const endpoint = getDeployAppEndpoint(app, config.deploy?.org);

    success(`Agent deployed: ${revision.id}`);
    print(`  URL: ${endpoint}`);
    if (brokerToken) {
      await registerAgentEndpointWithBroker({
        brokerUrl,
        authToken: brokerToken,
        agentId: agentName,
        endpoint,
        config: entry,
      });
      print("  Broker registration: ok");
    }

    print(`
✓ Agent "${agentName}" published to Deno Deploy!

  The agent exposes a broker-driven runtime.
  It talks to the broker for LLM calls, tool execution, and durable persistence.

  To send a message to this agent:
    From another agent: broker.sendTextTask("${agentName}", "instruction")
    From the broker: route a task_submit with targetAgent="${agentName}"
`);
  } catch (e) {
    error(`Error: ${(e as Error).message}`);
  }
}

export function generateAgentEntrypoint(
  agentId: string,
  entry: AgentEntry,
): string {
  return `// Auto-generated DenoClaw Agent Runtime
// Agent: ${agentId} | Model: ${entry.model ?? "unknown"}

import { startDeployedAgentRuntime } from "./src/agent/deploy_runtime.ts";

await startDeployedAgentRuntime({
  agentId: ${JSON.stringify(agentId)},
  entry: ${JSON.stringify(entry, null, 2)},
});
`;
}
