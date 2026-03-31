import { assertEquals } from "@std/assert";
import {
  AgentRuntimeGrantStore,
  deriveAgentRuntimeCapabilities,
  deriveAgentRuntimeCapabilitiesFromEntry,
} from "./runtime_capabilities.ts";

Deno.test("deriveAgentRuntimeCapabilities projects sandbox policy for planning", () => {
  const capabilities = deriveAgentRuntimeCapabilities({
    sandboxConfig: {
      allowedPermissions: ["net", "run", "read"],
      networkAllow: ["api.example.com"],
      execPolicy: {
        security: "allowlist",
        allowedCommands: ["git", "deno"],
      },
    },
    availablePeers: ["bob", "alice"],
  });

  assertEquals(capabilities.version, "runtime-capabilities-v1");
  assertEquals(
    capabilities.fingerprint.includes("runtime-capabilities-v1"),
    true,
  );
  assertEquals(capabilities.tools.shell.enabled, true);
  assertEquals(capabilities.tools.shell.execMode, "direct");
  assertEquals(capabilities.tools.shell.policyMode, "allowlist");
  assertEquals(capabilities.tools.read_file.enabled, true);
  assertEquals(capabilities.tools.write_file.enabled, false);
  assertEquals(capabilities.tools.web_fetch.enabled, true);
  assertEquals(capabilities.tools.send_to_agent.availablePeers, [
    "alice",
    "bob",
  ]);
  assertEquals(capabilities.sandbox.network.mode, "restricted");
  assertEquals(capabilities.sandbox.permissions, ["net", "read", "run"]);
  assertEquals(capabilities.sandbox.privilegeElevation.supported, false);
  assertEquals(capabilities.sandbox.privilegeElevation.authority, "none");
});

Deno.test("deriveAgentRuntimeCapabilities stays explicit when no sandbox policy is configured", () => {
  const capabilities = deriveAgentRuntimeCapabilities();

  assertEquals(capabilities.tools.shell.enabled, true);
  assertEquals(capabilities.tools.shell.execMode, "unknown");
  assertEquals(capabilities.tools.shell.policyMode, "unknown");
  assertEquals(capabilities.sandbox.policyConfigured, false);
  assertEquals(capabilities.sandbox.network.mode, "unknown");
  assertEquals(capabilities.sandbox.permissions, []);
  assertEquals(capabilities.sandbox.privilegeElevation.authority, "none");
});

Deno.test("deriveAgentRuntimeCapabilities reflects explicit shell settings", () => {
  const capabilities = deriveAgentRuntimeCapabilities({
    sandboxConfig: {
      allowedPermissions: ["run"],
      execPolicy: {
        security: "full",
      },
      shell: {
        mode: "system-shell",
      },
    },
  });

  assertEquals(capabilities.tools.shell.enabled, true);
  assertEquals(capabilities.tools.shell.execMode, "system-shell");
  assertEquals(capabilities.tools.shell.policyMode, "full");
});

Deno.test("deriveAgentRuntimeCapabilities reflects disabled shell tool", () => {
  const capabilities = deriveAgentRuntimeCapabilities({
    sandboxConfig: {
      allowedPermissions: ["run"],
      execPolicy: {
        security: "allowlist",
        allowedCommands: ["git"],
      },
      shell: {
        enabled: false,
      },
    },
  });

  assertEquals(capabilities.tools.shell.enabled, false);
  assertEquals(capabilities.tools.shell.execMode, "disabled");
  assertEquals(capabilities.tools.shell.policyMode, "allowlist");
});

Deno.test("AgentRuntimeGrantStore records temporary privilege elevation grants", () => {
  const store = new AgentRuntimeGrantStore();

  store.grantPrivilegeElevation({
    scope: "task",
    grants: [
      {
        permission: "net",
        hosts: ["api.github.com"],
      },
      {
        permission: "write",
        paths: ["/workspace/repo/docs"],
      },
    ],
    source: "broker-resume",
    grantedAt: "2025-01-15T10:31:00.000Z",
  });

  assertEquals(store.list(), [{
    kind: "privilege-elevation",
    scope: "task",
    grants: [
      {
        permission: "net",
        hosts: ["api.github.com"],
      },
      {
        permission: "write",
        paths: ["/workspace/repo/docs"],
      },
    ],
    grantedAt: "2025-01-15T10:31:00.000Z",
    source: "broker-resume",
  }]);
});

Deno.test("deriveAgentRuntimeCapabilitiesFromEntry applies defaults fallback", () => {
  const capabilities = deriveAgentRuntimeCapabilitiesFromEntry(
    { peers: ["bob"] },
    {
      allowedPermissions: ["run"],
      execPolicy: {
        security: "allowlist",
        allowedCommands: ["git"],
      },
    },
  );

  assertEquals(capabilities.tools.shell.enabled, true);
  assertEquals(capabilities.tools.shell.execMode, "direct");
  assertEquals(capabilities.tools.shell.policyMode, "allowlist");
  assertEquals(capabilities.tools.send_to_agent.availablePeers, ["bob"]);
  assertEquals(capabilities.sandbox.permissions, ["run"]);
});

Deno.test("deriveAgentRuntimeCapabilities can advertise broker privilege elevation support", () => {
  const capabilities = deriveAgentRuntimeCapabilities({
    sandboxConfig: {
      allowedPermissions: ["read", "write"],
    },
    privilegeElevationSupported: true,
  });

  assertEquals(capabilities.sandbox.privilegeElevation.supported, true);
  assertEquals(capabilities.sandbox.privilegeElevation.authority, "broker");
  assertEquals(capabilities.sandbox.privilegeElevation.requestTimeoutSec, 300);
  assertEquals(
    capabilities.sandbox.privilegeElevation.sessionGrantTtlSec,
    1800,
  );
});

Deno.test("deriveAgentRuntimeCapabilities can disable broker privilege elevation per agent", () => {
  const capabilities = deriveAgentRuntimeCapabilities({
    sandboxConfig: {
      allowedPermissions: ["read", "write"],
      privilegeElevation: {
        enabled: false,
      },
    },
    privilegeElevationSupported: true,
  });

  assertEquals(capabilities.sandbox.privilegeElevation.supported, false);
  assertEquals(capabilities.sandbox.privilegeElevation.authority, "none");
  assertEquals(capabilities.sandbox.privilegeElevation.scopes, []);
});

Deno.test("deriveAgentRuntimeCapabilities respects configured privilege elevation scopes", () => {
  const capabilities = deriveAgentRuntimeCapabilities({
    sandboxConfig: {
      allowedPermissions: ["read"],
      privilegeElevation: {
        scopes: ["task"],
        requestTimeoutSec: 90,
        sessionGrantTtlSec: 600,
      },
    },
    privilegeElevationSupported: true,
  });

  assertEquals(capabilities.sandbox.privilegeElevation.supported, true);
  assertEquals(capabilities.sandbox.privilegeElevation.scopes, ["task"]);
  assertEquals(capabilities.sandbox.privilegeElevation.requestTimeoutSec, 90);
  assertEquals(capabilities.sandbox.privilegeElevation.sessionGrantTtlSec, 600);
});
