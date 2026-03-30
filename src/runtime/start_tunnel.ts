import { ask } from "../cli/prompt.ts";
import { LocalRelay } from "../orchestration/relay.ts";
import { createRelayToolExecutionPort } from "../orchestration/bootstrap.ts";

export async function startLocalTunnel(urlArg?: string): Promise<void> {
  const brokerUrl = urlArg ||
    await ask("Broker WebSocket URL", "ws://localhost:3000/tunnel");
  const token = await ask("Invite token", "dev-token");

  const tools: string[] = ["shell", "read_file", "write_file"];

  console.log("\nCapabilities:");
  console.log(`  Tools: ${tools.join(", ")}`);

  const relay = new LocalRelay({
    brokerUrl,
    inviteToken: token,
    capabilities: { tools },
    autoApprove: true,
  }, {
    toolExecution: createRelayToolExecutionPort(tools),
  });

  await relay.connect();
  console.log("\nTunnel connected. Press Ctrl+C to disconnect.");

  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  try {
    await new Promise((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new Error("shutdown")));
    });
  } catch {
    relay.disconnect();
    console.log("Tunnel disconnected.");
  }
}
