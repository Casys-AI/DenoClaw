import type { SandboxPermission } from "../../../shared/types.ts";

/** Map SandboxPermission → Deno CLI flag. */
export function permissionToFlag(
  perm: SandboxPermission,
  networkAllow?: string[],
): string {
  switch (perm) {
    case "read":
      return "--allow-read";
    case "write":
      return "--allow-write";
    case "run":
      return "--allow-run";
    case "net":
      return networkAllow?.length
        ? `--allow-net=${networkAllow.join(",")}`
        : "--allow-net";
    case "env":
      return "--allow-env";
    case "ffi":
      return "--allow-ffi";
  }
}
