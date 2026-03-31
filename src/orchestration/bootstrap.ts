import type { Config } from "../config/types.ts";
import type { BrokerServerDeps } from "./broker/server.ts";
import type { ToolExecutionPort } from "./tool_execution_port.ts";
import {
  getMaxSandboxesPerBroker,
  getSandboxAccessToken,
} from "../shared/deploy_credentials.ts";
import { DenoSandboxBackend } from "../agent/tools/backends/cloud.ts";
import { LocalToolExecutionAdapter } from "./adapters/tool_execution_local.ts";
import { BrokerSandboxManager } from "./broker/sandbox_manager.ts";

export function createBrokerToolExecutionPort(
  _config: Config,
): ToolExecutionPort {
  const sandboxToken = getSandboxAccessToken() ?? "";
  const sandbox = sandboxToken
    ? new BrokerSandboxManager({
      maxSandboxes: getMaxSandboxesPerBroker(),
      createBackend: (sandboxConfig, _context, labels) =>
        new DenoSandboxBackend(sandboxConfig, sandboxToken, {
          trustGrantedPermissions: true,
          labels,
        }),
    })
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

export function createRelayToolExecutionPort(
  tools: string[],
): ToolExecutionPort {
  return LocalToolExecutionAdapter.forRelay(tools);
}
