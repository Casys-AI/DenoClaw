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
    case "schedule":
      throw new Error(
        "schedule is a broker-owned permission and has no sandbox CLI flag",
      );
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
