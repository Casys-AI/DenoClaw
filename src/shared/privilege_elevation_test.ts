import { assertEquals } from "@std/assert";
import {
  arePrivilegeElevationGrantResourcesSubset,
  filterActivePrivilegeElevationGrants,
  findMatchingPrivilegeElevationGrantResources,
  formatPrivilegeElevationGrantResources,
  formatPrivilegeElevationPrompt,
  getPrivilegeElevationGrantSignature,
  isPrivilegeElevationExpired,
  isPrivilegeElevationScopeWithin,
  matchesPrivilegeElevationGrantResource,
  resolvePrivilegeElevationExpiry,
} from "./privilege_elevation.ts";

Deno.test("matchesPrivilegeElevationGrantResource matches write paths by exact path and prefix", () => {
  assertEquals(
    matchesPrivilegeElevationGrantResource(
      { permission: "write", paths: ["docs"] },
      "write_file",
      { path: "docs/plan.md" },
    ),
    true,
  );
  assertEquals(
    matchesPrivilegeElevationGrantResource(
      { permission: "write", paths: ["docs/plan.md"] },
      "write_file",
      { path: "docs/plan.md" },
    ),
    true,
  );
  assertEquals(
    matchesPrivilegeElevationGrantResource(
      { permission: "write", paths: ["docs/plan.md"] },
      "write_file",
      { path: "docs/other.md" },
    ),
    false,
  );
});

Deno.test("matchesPrivilegeElevationGrantResource matches net hosts exactly", () => {
  assertEquals(
    matchesPrivilegeElevationGrantResource(
      { permission: "net", hosts: ["api.example.com"] },
      "web_fetch",
      { url: "https://api.example.com/path" },
    ),
    true,
  );
  assertEquals(
    matchesPrivilegeElevationGrantResource(
      { permission: "net", hosts: ["api.example.com"] },
      "web_fetch",
      { url: "https://other.example.com/path" },
    ),
    false,
  );
});

Deno.test("findMatchingPrivilegeElevationGrantResources returns only resources matching the current tool args", () => {
  const matching = findMatchingPrivilegeElevationGrantResources(
    [{
      kind: "privilege-elevation",
      scope: "task",
      grants: [
        { permission: "write", paths: ["docs"] },
        { permission: "net", hosts: ["api.example.com"] },
      ],
      grantedAt: "2026-03-31T00:00:00.000Z",
      source: "broker-resume",
    }],
    "write_file",
    { path: "docs/plan.md" },
    ["write"],
  );

  assertEquals(matching.length, 1);
  assertEquals(matching[0]?.resource, { permission: "write", paths: ["docs"] });
});

Deno.test("getPrivilegeElevationGrantSignature is stable for equivalent grants", () => {
  const grant = {
    kind: "privilege-elevation" as const,
    scope: "once" as const,
    grants: [{ permission: "net" as const, hosts: ["api.example.com"] }],
    grantedAt: "2026-03-31T00:00:00.000Z",
    source: "broker-resume" as const,
  };

  assertEquals(
    getPrivilegeElevationGrantSignature(grant),
    getPrivilegeElevationGrantSignature({ ...grant }),
  );
});

Deno.test("arePrivilegeElevationGrantResourcesSubset allows narrower resource grants", () => {
  assertEquals(
    arePrivilegeElevationGrantResourcesSubset(
      [{ permission: "write", paths: ["docs/plan.md"] }],
      [{ permission: "write", paths: ["docs"] }],
    ),
    true,
  );
  assertEquals(
    arePrivilegeElevationGrantResourcesSubset(
      [{ permission: "net", hosts: ["other.example.com"] }],
      [{ permission: "net", hosts: ["api.example.com"] }],
    ),
    false,
  );
});

Deno.test("isPrivilegeElevationScopeWithin only allows equal or narrower scopes", () => {
  assertEquals(isPrivilegeElevationScopeWithin("once", "session"), true);
  assertEquals(isPrivilegeElevationScopeWithin("task", "task"), true);
  assertEquals(isPrivilegeElevationScopeWithin("session", "task"), false);
});

Deno.test("formatPrivilegeElevationGrantResources joins resource grants compactly", () => {
  assertEquals(
    formatPrivilegeElevationGrantResources([
      { permission: "write", paths: ["docs"] },
      { permission: "net", hosts: ["api.example.com"] },
    ]),
    "write paths=[docs], net hosts=[api.example.com]",
  );
});

Deno.test("formatPrivilegeElevationPrompt renders scope and requested resources", () => {
  assertEquals(
    formatPrivilegeElevationPrompt({
      grants: [{ permission: "write", paths: ["note.txt"] }],
      scope: "task",
      tool: "write_file",
    }),
    "Temporary privilege elevation required for write_file (this task): write paths=[note.txt]",
  );
});

Deno.test("resolvePrivilegeElevationExpiry adds a TTL in seconds", () => {
  assertEquals(
    resolvePrivilegeElevationExpiry(
      60,
      new Date("2026-03-31T00:00:00.000Z"),
    ),
    "2026-03-31T00:01:00.000Z",
  );
});

Deno.test("filterActivePrivilegeElevationGrants drops expired grants", () => {
  assertEquals(
    filterActivePrivilegeElevationGrants(
      [
        {
          kind: "privilege-elevation",
          scope: "session",
          grants: [{ permission: "write", paths: ["docs"] }],
          grantedAt: "2026-03-31T00:00:00.000Z",
          expiresAt: "2026-03-31T00:05:00.000Z",
          source: "broker-resume",
        },
        {
          kind: "privilege-elevation",
          scope: "session",
          grants: [{ permission: "net", hosts: ["api.example.com"] }],
          grantedAt: "2026-03-31T00:00:00.000Z",
          expiresAt: "2026-03-31T00:15:00.000Z",
          source: "broker-resume",
        },
      ],
      Date.parse("2026-03-31T00:10:00.000Z"),
    ),
    [{
      kind: "privilege-elevation",
      scope: "session",
      grants: [{ permission: "net", hosts: ["api.example.com"] }],
      grantedAt: "2026-03-31T00:00:00.000Z",
      expiresAt: "2026-03-31T00:15:00.000Z",
      source: "broker-resume",
    }],
  );
  assertEquals(
    isPrivilegeElevationExpired(
      "2026-03-31T00:05:00.000Z",
      Date.parse("2026-03-31T00:10:00.000Z"),
    ),
    true,
  );
});
