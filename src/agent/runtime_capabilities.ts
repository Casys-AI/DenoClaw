export {
  AgentRuntimeGrantStore,
  deriveAgentRuntimeCapabilities,
  deriveAgentRuntimeCapabilitiesFromEntry,
  formatAgentRuntimeCapabilities,
  formatAgentRuntimeGrants,
} from "../shared/runtime_capabilities.ts";
export {
  formatPrivilegeElevationGrantResource,
  listGrantedPermissions,
} from "../shared/privilege_elevation.ts";

export type {
  AgentNetworkMode,
  AgentPrivilegeElevationScope,
  AgentRuntimeCapabilities,
  AgentRuntimeGrant,
  AgentRuntimePrivilegeElevationGrant,
  AgentShellExecMode,
  AgentShellPolicyMode,
} from "../shared/runtime_capabilities.ts";
export type {
  PrivilegeElevationGrant,
  PrivilegeElevationGrantResource,
  PrivilegeElevationScope,
} from "../shared/privilege_elevation.ts";
