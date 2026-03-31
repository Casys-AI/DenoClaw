import type { AgentEntry, SandboxConfig, SandboxPermission } from "./types.ts";
import type {
  PrivilegeElevationGrant,
  PrivilegeElevationScope,
} from "./privilege_elevation.ts";
import { formatPrivilegeElevationGrantResource } from "./privilege_elevation.ts";

export type AgentPrivilegeElevationScope = PrivilegeElevationScope;
export type AgentShellExecMode =
  | "unknown"
  | "disabled"
  | "direct"
  | "system-shell";
export type AgentShellPolicyMode =
  | "unknown"
  | "deny"
  | "allowlist"
  | "full";
export type AgentNetworkMode = "unknown" | "none" | "restricted" | "open";

export type AgentRuntimePrivilegeElevationGrant = PrivilegeElevationGrant;
export type AgentRuntimeGrant = AgentRuntimePrivilegeElevationGrant;

export interface AgentRuntimeCapabilities {
  version: string;
  fingerprint: string;
  tools: {
    shell: {
      enabled: boolean;
      execMode: AgentShellExecMode;
      policyMode: AgentShellPolicyMode;
    };
    read_file: { enabled: boolean };
    write_file: { enabled: boolean };
    web_fetch: { enabled: boolean };
    memory: { enabled: boolean };
    send_to_agent: {
      enabled: boolean;
      availablePeers: string[];
    };
  };
  sandbox: {
    policyConfigured: boolean;
    permissions: SandboxPermission[];
    network: {
      enabled: boolean;
      mode: AgentNetworkMode;
      allowlist: string[];
    };
    privilegeElevation: {
      supported: boolean;
      authority: "none" | "broker";
      scopes: AgentPrivilegeElevationScope[];
      requestTimeoutSec?: number;
      sessionGrantTtlSec?: number;
    };
  };
}

export interface DeriveAgentRuntimeCapabilitiesOptions {
  sandboxConfig?: SandboxConfig;
  availablePeers?: string[];
  privilegeElevationSupported?: boolean;
}

const CAPABILITIES_VERSION = "runtime-capabilities-v1";
const PRIVILEGE_ELEVATION_SCOPES: AgentPrivilegeElevationScope[] = [
  "once",
  "task",
  "session",
];
const DEFAULT_PRIVILEGE_ELEVATION_REQUEST_TIMEOUT_SEC = 300;
const DEFAULT_PRIVILEGE_ELEVATION_SESSION_GRANT_TTL_SEC = 1800;

export function deriveAgentRuntimeCapabilities(
  options: DeriveAgentRuntimeCapabilitiesOptions = {},
): AgentRuntimeCapabilities {
  const sandboxConfig = options.sandboxConfig;
  const permissions = [...(sandboxConfig?.allowedPermissions ?? [])].sort();
  const networkAllow = [...(sandboxConfig?.networkAllow ?? [])].sort();
  const execPolicy = sandboxConfig?.execPolicy;
  const shell = sandboxConfig?.shell;
  const availablePeers = [...(options.availablePeers ?? [])].sort();
  const privilegeElevation = resolvePrivilegeElevationCapabilities(
    sandboxConfig,
    options.privilegeElevationSupported ?? false,
  );
  const hasSandboxPolicy = Boolean(sandboxConfig);
  const shellEnabled = hasSandboxPolicy
    ? permissions.includes("run") && shell?.enabled !== false
    : true;
  const shellExecMode = !shellEnabled
    ? "disabled"
    : hasSandboxPolicy
    ? shell?.mode ?? "direct"
    : "unknown";
  const shellPolicyMode = execPolicy?.security ?? "unknown";

  const capabilitiesBase = {
    tools: {
      shell: {
        enabled: shellEnabled,
        execMode: shellExecMode,
        policyMode: shellPolicyMode,
      },
      read_file: {
        enabled: hasSandboxPolicy ? permissions.includes("read") : true,
      },
      write_file: {
        enabled: hasSandboxPolicy ? permissions.includes("write") : true,
      },
      web_fetch: {
        enabled: hasSandboxPolicy ? permissions.includes("net") : true,
      },
      memory: { enabled: true },
      send_to_agent: {
        enabled: availablePeers.length > 0,
        availablePeers,
      },
    },
    sandbox: {
      policyConfigured: hasSandboxPolicy,
      permissions,
      network: {
        enabled: permissions.includes("net"),
        mode: deriveNetworkMode(permissions, networkAllow, hasSandboxPolicy),
        allowlist: networkAllow,
      },
      privilegeElevation,
    },
  } satisfies Omit<AgentRuntimeCapabilities, "version" | "fingerprint">;

  return {
    version: CAPABILITIES_VERSION,
    fingerprint: computeRuntimeCapabilitiesFingerprint(capabilitiesBase),
    ...capabilitiesBase,
  };
}

export function deriveAgentRuntimeCapabilitiesFromEntry(
  entry?: AgentEntry,
  defaultsSandbox?: SandboxConfig,
  options: Omit<
    DeriveAgentRuntimeCapabilitiesOptions,
    "sandboxConfig" | "availablePeers"
  > = {},
): AgentRuntimeCapabilities {
  const effectiveSandbox = entry?.sandbox ?? defaultsSandbox;
  return deriveAgentRuntimeCapabilities({
    sandboxConfig: effectiveSandbox,
    availablePeers: entry?.peers ?? [],
    ...options,
  });
}

export function formatAgentRuntimeCapabilities(
  capabilities: AgentRuntimeCapabilities,
): string[] {
  const lines = [
    `Capabilities version: ${capabilities.version}`,
    `Capabilities fingerprint: ${capabilities.fingerprint}`,
    `Shell: ${
      capabilities.tools.shell.enabled ? "enabled" : "disabled"
    } (mode: ${capabilities.tools.shell.execMode}, policy: ${capabilities.tools.shell.policyMode})`,
  ];

  lines.push(
    `File tools: read=${
      capabilities.tools.read_file.enabled ? "yes" : "no"
    }, write=${capabilities.tools.write_file.enabled ? "yes" : "no"}`,
  );
  lines.push(
    `Network: ${
      capabilities.sandbox.network.enabled
        ? capabilities.sandbox.network.mode
        : "disabled"
    }`,
  );

  if (capabilities.sandbox.network.allowlist.length > 0) {
    lines.push(
      `Network allowlist: ${capabilities.sandbox.network.allowlist.join(", ")}`,
    );
  }

  if (capabilities.sandbox.policyConfigured) {
    lines.push(
      `Sandbox permissions: ${
        capabilities.sandbox.permissions.length > 0
          ? capabilities.sandbox.permissions.join(", ")
          : "none"
      }`,
    );
  } else {
    lines.push("Sandbox policy metadata: not configured");
  }

  if (capabilities.tools.send_to_agent.enabled) {
    lines.push(
      `Peer routing: enabled (${
        capabilities.tools.send_to_agent.availablePeers.join(", ")
      })`,
    );
  } else {
    lines.push("Peer routing: no declared peers");
  }

  lines.push(
    `Privilege elevation: ${
      capabilities.sandbox.privilegeElevation.supported
        ? `supported via ${capabilities.sandbox.privilegeElevation.authority} (${
          capabilities.sandbox.privilegeElevation.scopes.join(", ")
        }, request timeout=${capabilities.sandbox.privilegeElevation.requestTimeoutSec}s, session ttl=${capabilities.sandbox.privilegeElevation.sessionGrantTtlSec}s)`
        : "not available in this runtime"
    }`,
  );

  return lines;
}

export function formatAgentRuntimeGrants(
  grants: AgentRuntimeGrant[],
): string[] {
  return grants.map((grant) => {
    const resources = grant.grants.map(formatPrivilegeElevationGrantResource)
      .join("; ");
    return `Temporary ${grant.kind}: ${resources} (${grant.scope} scope, granted via ${grant.source})`;
  });
}

export class AgentRuntimeGrantStore {
  private readonly grants = new Map<string, AgentRuntimeGrant>();

  list(): AgentRuntimeGrant[] {
    return [...this.grants.values()].sort((a, b) =>
      this.sortKeyFor(a).localeCompare(this.sortKeyFor(b))
    );
  }

  grantPrivilegeElevation(
    input: Omit<AgentRuntimePrivilegeElevationGrant, "kind" | "grantedAt"> & {
      grantedAt?: string;
    },
  ): void {
    const grant: AgentRuntimePrivilegeElevationGrant = {
      kind: "privilege-elevation",
      grantedAt: input.grantedAt ?? new Date().toISOString(),
      ...input,
    };
    this.grants.set(this.keyFor(grant), grant);
  }

  private keyFor(grant: AgentRuntimeGrant): string {
    return [
      grant.kind,
      grant.scope,
      JSON.stringify(grant.grants),
    ].join(":");
  }

  private sortKeyFor(grant: AgentRuntimeGrant): string {
    return `${grant.scope}:${JSON.stringify(grant.grants)}`;
  }
}

function deriveNetworkMode(
  permissions: SandboxPermission[],
  networkAllow: string[],
  hasSandboxPolicy: boolean,
): AgentNetworkMode {
  if (!hasSandboxPolicy) return "unknown";
  if (!permissions.includes("net")) return "none";
  return networkAllow.length > 0 ? "restricted" : "open";
}

function resolvePrivilegeElevationCapabilities(
  sandboxConfig: SandboxConfig | undefined,
  brokerSupported: boolean,
): AgentRuntimeCapabilities["sandbox"]["privilegeElevation"] {
  const config = sandboxConfig?.privilegeElevation;
  const enabled = brokerSupported && config?.enabled !== false;
  return {
    supported: enabled,
    authority: enabled ? "broker" : "none",
    scopes: enabled ? resolvePrivilegeElevationScopes(config?.scopes) : [],
    requestTimeoutSec: enabled
      ? resolvePositiveConfigValue(
        config?.requestTimeoutSec,
        DEFAULT_PRIVILEGE_ELEVATION_REQUEST_TIMEOUT_SEC,
      )
      : undefined,
    sessionGrantTtlSec: enabled
      ? resolvePositiveConfigValue(
        config?.sessionGrantTtlSec,
        DEFAULT_PRIVILEGE_ELEVATION_SESSION_GRANT_TTL_SEC,
      )
      : undefined,
  };
}

function resolvePrivilegeElevationScopes(
  scopes: PrivilegeElevationScope[] | undefined,
): AgentPrivilegeElevationScope[] {
  const configured =
    scopes?.filter((scope): scope is AgentPrivilegeElevationScope =>
      scope === "once" || scope === "task" || scope === "session"
    ) ?? [];
  return configured.length > 0
    ? [...new Set(configured)]
    : [...PRIVILEGE_ELEVATION_SCOPES];
}

function resolvePositiveConfigValue(
  configured: number | undefined,
  fallback: number,
): number {
  return typeof configured === "number" && Number.isFinite(configured) &&
      configured > 0
    ? configured
    : fallback;
}

function computeRuntimeCapabilitiesFingerprint(
  capabilities: Omit<AgentRuntimeCapabilities, "version" | "fingerprint">,
): string {
  const parts = [
    CAPABILITIES_VERSION,
    `shell=${capabilities.tools.shell.enabled ? "on" : "off"}`,
    `mode=${capabilities.tools.shell.execMode}`,
    `policy=${capabilities.tools.shell.policyMode}`,
    `perms=${capabilities.sandbox.permissions.join(",")}`,
    `net=${capabilities.sandbox.network.mode}`,
    `allow=${capabilities.sandbox.network.allowlist.join(",")}`,
    `peers=${capabilities.tools.send_to_agent.availablePeers.join(",")}`,
    `elevation=${capabilities.sandbox.privilegeElevation.authority}:${
      capabilities.sandbox.privilegeElevation.scopes.join(",")
    }:${capabilities.sandbox.privilegeElevation.requestTimeoutSec ?? "na"}:${
      capabilities.sandbox.privilegeElevation.sessionGrantTtlSec ?? "na"
    }`,
  ];
  return parts.join("|");
}
