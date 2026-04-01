import type { SandboxPermission } from "./types.ts";

export type PrivilegeElevationScope = "once" | "task" | "session";

export interface NetPrivilegeGrantResource {
  permission: "net";
  hosts: string[];
}

export interface WritePrivilegeGrantResource {
  permission: "write";
  paths: string[];
}

export interface ReadPrivilegeGrantResource {
  permission: "read";
  paths: string[];
}

export interface EnvPrivilegeGrantResource {
  permission: "env";
  keys: string[];
}

export interface FfiPrivilegeGrantResource {
  permission: "ffi";
  libraries: string[];
}

/**
 * Future shell-oriented elevation should widen broker policy groups rather than
 * approving raw command strings.
 */
export interface RunPrivilegeGrantResource {
  permission: "run";
  groups: string[];
}

export interface SchedulePrivilegeGrantResource {
  permission: "schedule";
  groups: string[];
}

export type PrivilegeElevationGrantResource =
  | NetPrivilegeGrantResource
  | WritePrivilegeGrantResource
  | ReadPrivilegeGrantResource
  | EnvPrivilegeGrantResource
  | FfiPrivilegeGrantResource
  | RunPrivilegeGrantResource
  | SchedulePrivilegeGrantResource;

export interface PrivilegeElevationGrant {
  kind: "privilege-elevation";
  scope: PrivilegeElevationScope;
  grants: PrivilegeElevationGrantResource[];
  grantedAt: string;
  expiresAt?: string;
  source: "interactive-approval" | "broker-resume";
}

export function listGrantedPermissions(
  grants: PrivilegeElevationGrantResource[],
): SandboxPermission[] {
  return [...new Set(grants.map((grant) => grant.permission))].sort();
}

export function getPrivilegeElevationGrantSignature(
  grant: PrivilegeElevationGrant,
): string {
  return JSON.stringify([
    grant.kind,
    grant.scope,
    grant.grantedAt,
    grant.expiresAt,
    grant.source,
    grant.grants,
  ]);
}

export function resolvePrivilegeElevationExpiry(
  ttlSec: number | undefined,
  now = new Date(),
): string | undefined {
  if (typeof ttlSec !== "number" || !Number.isFinite(ttlSec) || ttlSec <= 0) {
    return undefined;
  }
  return new Date(now.getTime() + ttlSec * 1000).toISOString();
}

export function isPrivilegeElevationExpired(
  expiresAt: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

export function filterActivePrivilegeElevationGrants(
  grants: PrivilegeElevationGrant[],
  nowMs = Date.now(),
): PrivilegeElevationGrant[] {
  return grants.filter((grant) =>
    !isPrivilegeElevationExpired(grant.expiresAt, nowMs)
  );
}

export function formatPrivilegeElevationGrantResource(
  grant: PrivilegeElevationGrantResource,
): string {
  switch (grant.permission) {
    case "net":
      return `net hosts=[${grant.hosts.join(", ")}]`;
    case "write":
      return `write paths=[${grant.paths.join(", ")}]`;
    case "read":
      return `read paths=[${grant.paths.join(", ")}]`;
    case "env":
      return `env keys=[${grant.keys.join(", ")}]`;
    case "ffi":
      return `ffi libraries=[${grant.libraries.join(", ")}]`;
    case "run":
      return `run groups=[${grant.groups.join(", ")}]`;
    case "schedule":
      return `schedule groups=[${grant.groups.join(", ")}]`;
  }
}

export function formatPrivilegeElevationGrantResources(
  grants: PrivilegeElevationGrantResource[],
): string {
  return grants.map((grant) => formatPrivilegeElevationGrantResource(grant))
    .join(", ");
}

export function formatPrivilegeElevationScopeLabel(
  scope: PrivilegeElevationScope,
): string {
  switch (scope) {
    case "once":
      return "this action";
    case "task":
      return "this task";
    case "session":
      return "this session";
  }
}

export function pickBroadestPrivilegeElevationScope(
  scopes: readonly unknown[] | undefined,
  fallback: PrivilegeElevationScope = "task",
): PrivilegeElevationScope {
  const validScopes =
    scopes?.filter((scope): scope is PrivilegeElevationScope =>
      scope === "once" || scope === "task" || scope === "session"
    ) ?? [];
  if (validScopes.length === 0) return fallback;
  return [...validScopes].sort((left, right) =>
    privilegeElevationScopeRank(right) - privilegeElevationScopeRank(left)
  )[0];
}

export function formatPrivilegeElevationPrompt(
  options: {
    grants: PrivilegeElevationGrantResource[];
    scope: PrivilegeElevationScope;
    tool?: string;
    binary?: string;
    command?: string;
  },
): string {
  const target = options.binary ?? options.tool ?? options.command;
  const targetLabel = target ? ` for ${target}` : "";
  const scopeLabel = formatPrivilegeElevationScopeLabel(options.scope);
  const resourceLabel = formatPrivilegeElevationGrantResources(options.grants);
  return `Temporary privilege elevation required${targetLabel} (${scopeLabel}): ${resourceLabel}`;
}

export function suggestPrivilegeElevationGrantResources(
  tool: string,
  args: Record<string, unknown>,
  permissions: SandboxPermission[],
): PrivilegeElevationGrantResource[] {
  return permissions.map((permission) =>
    suggestPrivilegeElevationGrantResource(tool, args, permission)
  );
}

export function matchesPrivilegeElevationGrantResource(
  grant: PrivilegeElevationGrantResource,
  tool: string,
  args: Record<string, unknown>,
): boolean {
  switch (grant.permission) {
    case "net": {
      const url = typeof args.url === "string" ? args.url : undefined;
      const host = url ? tryParseHostname(url) : undefined;
      if (!host) return false;
      return grant.hosts.some((allowedHost) => matchHost(host, allowedHost));
    }
    case "write":
    case "read": {
      const path = typeof args.path === "string" ? args.path : undefined;
      if (!path) return false;
      return grant.paths.some((allowedPath) => matchPath(path, allowedPath));
    }
    case "env": {
      const key = typeof args.key === "string"
        ? args.key
        : typeof args.name === "string"
        ? args.name
        : undefined;
      if (!key) return false;
      return grant.keys.some((allowedKey) =>
        allowedKey === "*" || allowedKey === key
      );
    }
    case "ffi": {
      const library = typeof args.library === "string"
        ? args.library
        : undefined;
      if (!library) return false;
      return grant.libraries.some((allowedLib) =>
        allowedLib === "*" || allowedLib === library
      );
    }
    case "run":
      return grant.groups.includes("*") || grant.groups.includes(tool) ||
        (tool === "shell" && grant.groups.includes("shell"));
    case "schedule":
      return grant.groups.includes("*") || grant.groups.includes(tool);
  }
}

export function isPrivilegeElevationGrantResourceSubset(
  requested: PrivilegeElevationGrantResource,
  allowed: PrivilegeElevationGrantResource,
): boolean {
  if (requested.permission !== allowed.permission) return false;

  switch (requested.permission) {
    case "net": {
      const allowedNet = allowed as NetPrivilegeGrantResource;
      return requested.hosts.every((host) =>
        allowedNet.hosts.some((allowedHost: string) =>
          matchHost(host, allowedHost)
        )
      );
    }
    case "write": {
      const allowedWrite = allowed as WritePrivilegeGrantResource;
      return requested.paths.every((path) =>
        allowedWrite.paths.some((allowedPath: string) =>
          matchPath(path, allowedPath)
        )
      );
    }
    case "read": {
      const allowedRead = allowed as ReadPrivilegeGrantResource;
      return requested.paths.every((path) =>
        allowedRead.paths.some((allowedPath: string) =>
          matchPath(path, allowedPath)
        )
      );
    }
    case "env": {
      const allowedEnv = allowed as EnvPrivilegeGrantResource;
      return requested.keys.every((key) =>
        allowedEnv.keys.some((allowedKey: string) =>
          allowedKey === "*" || allowedKey === key
        )
      );
    }
    case "ffi": {
      const allowedFfi = allowed as FfiPrivilegeGrantResource;
      return requested.libraries.every((library) =>
        allowedFfi.libraries.some((allowedLib: string) =>
          allowedLib === "*" || allowedLib === library
        )
      );
    }
    case "run": {
      const allowedRun = allowed as RunPrivilegeGrantResource;
      return requested.groups.every((group) =>
        allowedRun.groups.some((allowedGroup: string) =>
          allowedGroup === "*" || allowedGroup === group
        )
      );
    }
    case "schedule": {
      const allowedSchedule = allowed as SchedulePrivilegeGrantResource;
      return requested.groups.every((group) =>
        allowedSchedule.groups.some((allowedGroup: string) =>
          allowedGroup === "*" || allowedGroup === group
        )
      );
    }
  }
}

export function arePrivilegeElevationGrantResourcesSubset(
  requested: PrivilegeElevationGrantResource[],
  allowed: PrivilegeElevationGrantResource[],
): boolean {
  return requested.every((requestedGrant) =>
    allowed.some((allowedGrant) =>
      isPrivilegeElevationGrantResourceSubset(requestedGrant, allowedGrant)
    )
  );
}

export function isPrivilegeElevationScopeWithin(
  requested: PrivilegeElevationScope,
  allowed: PrivilegeElevationScope,
): boolean {
  return privilegeElevationScopeRank(requested) <=
    privilegeElevationScopeRank(allowed);
}

export function findMatchingPrivilegeElevationGrantResources(
  grants: PrivilegeElevationGrant[],
  tool: string,
  args: Record<string, unknown>,
  requiredPermissions?: SandboxPermission[],
): Array<{
  grant: PrivilegeElevationGrant;
  resource: PrivilegeElevationGrantResource;
}> {
  const required = requiredPermissions
    ? new Set(requiredPermissions)
    : undefined;
  const matches: Array<{
    grant: PrivilegeElevationGrant;
    resource: PrivilegeElevationGrantResource;
  }> = [];

  for (const grant of grants) {
    if (isPrivilegeElevationExpired(grant.expiresAt)) continue;
    for (const resource of grant.grants) {
      if (required && !required.has(resource.permission)) continue;
      if (!matchesPrivilegeElevationGrantResource(resource, tool, args)) {
        continue;
      }
      matches.push({ grant, resource });
    }
  }

  return matches;
}

function suggestPrivilegeElevationGrantResource(
  tool: string,
  args: Record<string, unknown>,
  permission: SandboxPermission,
): PrivilegeElevationGrantResource {
  switch (permission) {
    case "net": {
      const url = typeof args.url === "string" ? args.url : undefined;
      const host = url ? tryParseHostname(url) : undefined;
      return { permission, hosts: host ? [host] : ["*"] };
    }
    case "write":
    case "read": {
      const path = typeof args.path === "string" ? args.path : undefined;
      return { permission, paths: path ? [path] : ["*"] };
    }
    case "env": {
      const key = typeof args.key === "string"
        ? args.key
        : typeof args.name === "string"
        ? args.name
        : undefined;
      return { permission, keys: key ? [key] : ["*"] };
    }
    case "ffi": {
      const library = typeof args.library === "string"
        ? args.library
        : undefined;
      return { permission, libraries: library ? [library] : ["*"] };
    }
    case "run":
      return {
        permission,
        groups: [tool === "shell" ? "shell" : tool],
      };
    case "schedule":
      return {
        permission,
        groups: [tool],
      };
  }
}

function tryParseHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function matchHost(host: string, allowedHost: string): boolean {
  if (allowedHost === "*") return true;
  return host.toLowerCase() === allowedHost.toLowerCase();
}

function matchPath(path: string, allowedPath: string): boolean {
  if (allowedPath === "*") return true;
  const normalizedPath = normalizePathForMatch(path);
  const normalizedAllowed = normalizePathForMatch(allowedPath);
  return normalizedPath === normalizedAllowed ||
    normalizedPath.startsWith(`${normalizedAllowed}/`);
}

function normalizePathForMatch(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized === "/") return normalized;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function privilegeElevationScopeRank(scope: PrivilegeElevationScope): number {
  switch (scope) {
    case "once":
      return 0;
    case "task":
      return 1;
    case "session":
      return 2;
  }
}
