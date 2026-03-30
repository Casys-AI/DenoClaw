import { assertEquals } from "@std/assert";
import { DenoSandboxBackend } from "./cloud.ts";
import type {
  ExecPolicy,
  SandboxConfig,
  SandboxExecRequest,
} from "../../../shared/types.ts";

const basePolicy: ExecPolicy = {
  security: "allowlist",
  allowedCommands: ["echo"],
  ask: "off",
  askFallback: "deny",
};

function shellReq(
  command: string,
  policy: ExecPolicy = basePolicy,
): SandboxExecRequest {
  return {
    tool: "shell",
    args: { command, dry_run: false },
    permissions: ["run"],
    execPolicy: policy,
  };
}

Deno.test(
  "DenoSandboxBackend denies permissions not allowed before init",
  async () => {
    const sandbox: SandboxConfig = {
      backend: "cloud",
      allowedPermissions: ["read"],
      maxDurationSec: 5,
    };
    const backend = new DenoSandboxBackend(sandbox, "fake-token");

    const result = await backend.execute({
      tool: "web_fetch",
      args: { url: "https://example.com" },
      permissions: ["net"],
      execPolicy: basePolicy,
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "SANDBOX_PERMISSION_DENIED");
    await backend.close();
  },
);

Deno.test("DenoSandboxBackend security=deny blocks shell before init", async () => {
  const sandbox: SandboxConfig = {
    backend: "cloud",
    allowedPermissions: ["run"],
    maxDurationSec: 5,
  };
  const backend = new DenoSandboxBackend(sandbox, "fake-token");

  const result = await backend.execute(
    shellReq("echo hi", { security: "deny", ask: "off" }),
  );

  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
  await backend.close();
});
