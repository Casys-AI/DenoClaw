import type { Config } from "../config/types.ts";
import { BrokerServer } from "../orchestration/broker/server.ts";
import { createBrokerServerDeps } from "../orchestration/bootstrap.ts";

export async function startBrokerRuntime(
  config: Config,
  port = 3000,
): Promise<void> {
  const srv = new BrokerServer(config, createBrokerServerDeps(config));
  await srv.start(port);

  console.log(`Broker started on port ${port}`);
  console.log(`  Health: http://localhost:${port}/health`);
  console.log(`  Tunnel: ws://localhost:${port}/tunnel`);

  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  try {
    await new Promise((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new Error("shutdown")));
    });
  } catch {
    await srv.stop();
  }
}
