import { BrokerClient } from "../src/orchestration/client.ts";
import { WebSocketBrokerTransport } from "../src/orchestration/transport.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const agentId = Deno.env.get("DENOCLAW_AGENT_ID") ?? "bob";
const authToken = requireEnv("DENOCLAW_API_TOKEN");
const brokerUrl = Deno.env.get("DENOCLAW_BROKER_URL") ??
  "https://denoclaw-broker.casys.deno.net";
const command = Deno.args[0] ?? "deno --version";

const transport = new WebSocketBrokerTransport(agentId, {
  brokerUrl,
  authToken,
});

const client = new BrokerClient(agentId, { transport });

try {
  await client.startListening();
  const result = await client.execTool("shell", {
    command,
    dry_run: false,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  client.close();
}
