import type { Config } from "../config/types.ts";
import type { BrokerServerDeps } from "./broker.ts";
import type { ToolExecutionPort } from "./tool_execution_port.ts";
import { DenoSandboxBackend } from "../agent/tools/backends/cloud.ts";
import { LocalToolExecutionAdapter } from "./adapters/tool_execution_local.ts";

export function createBrokerToolExecutionPort(config: Config): ToolExecutionPort {
  const sandboxToken = Deno.env.get("DENO_SANDBOX_API_TOKEN") ?? "";
  const defaultSandboxConfig = config.agents?.defaults?.sandbox ?? {
    allowedPermissions: [],
  };
  const sandbox = sandboxToken
    ? new DenoSandboxBackend(defaultSandboxConfig, sandboxToken)
    : null;

  return new LocalToolExecutionAdapter({
    sandbox,
    requireSandboxForPermissionedTools: true,
  });
}

export function createBrokerServerDeps(config: Config): BrokerServerDeps {
  return {
    toolExecution: createBrokerToolExecutionPort(config),
  };
}

export function createRelayToolExecutionPort(tools: string[]): ToolExecutionPort {
  return LocalToolExecutionAdapter.forRelay(tools);
}
