import { assertEquals } from "@std/assert";
import { resolveBrokerDeployNaming } from "./broker_deploy_naming.ts";

Deno.test("resolveBrokerDeployNaming migrates the legacy canonical broker name", () => {
  const result = resolveBrokerDeployNaming({
    storedApp: "denoclaw",
    storedKvDatabase: "denoclaw-kv",
  });

  assertEquals(result.app, "denoclaw-broker");
  assertEquals(result.kvDatabase, "denoclaw-broker-kv");
  assertEquals(result.migrationNotices.length, 2);
});

Deno.test("resolveBrokerDeployNaming preserves explicit app overrides", () => {
  const result = resolveBrokerDeployNaming({
    requestedApp: "custom-broker",
    storedApp: "denoclaw",
    storedKvDatabase: "denoclaw-kv",
  });

  assertEquals(result.app, "custom-broker");
  assertEquals(result.kvDatabase, "denoclaw-kv");
  assertEquals(result.migrationNotices, []);
});

Deno.test("resolveBrokerDeployNaming derives a canonical KV for custom stored apps", () => {
  const result = resolveBrokerDeployNaming({
    storedApp: "casys-broker",
  });

  assertEquals(result.app, "casys-broker");
  assertEquals(result.kvDatabase, "casys-broker-kv");
});
