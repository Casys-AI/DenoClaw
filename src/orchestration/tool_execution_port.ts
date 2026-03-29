import type { ExecPolicy, SandboxPermission, ToolResult } from "../shared/types.ts";
import type { TunnelCapabilities } from "./types.ts";

export interface ExecPolicyEvaluation {
  allowed: boolean;
  reason?: string;
  binary?: string;
}

/**
 * Port d'exécution d'outils consommé par la couche orchestration.
 *
 * Cette interface protège orchestration des implémentations concrètes
 * (registre local, outils built-in, règles d'exécution shell, etc.).
 */
export interface ToolExecutionPort {
  executeTool(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  getAdvertisedToolPermissions(tools: readonly string[]): Record<string, SandboxPermission[]>;
  resolveRequiredPermissions(
    tool: string,
    tunnelCapabilities: Iterable<TunnelCapabilities>,
  ): SandboxPermission[];
  evaluateExecPolicy(command: string, policy: ExecPolicy): ExecPolicyEvaluation;
}


export function createUnsupportedToolExecutionPort(): ToolExecutionPort {
  return {
    async executeTool(tool: string): Promise<ToolResult> {
      return {
        success: false,
        output: "",
        error: {
          code: "TOOL_EXECUTION_PORT_NOT_CONFIGURED",
          context: { tool },
          recovery: "Inject a ToolExecutionPort at application bootstrap",
        },
      };
    },
    getAdvertisedToolPermissions(): Record<string, SandboxPermission[]> {
      return {};
    },
    resolveRequiredPermissions(): SandboxPermission[] {
      return [];
    },
    evaluateExecPolicy(): ExecPolicyEvaluation {
      return { allowed: false, reason: "denied" };
    },
  };
}
