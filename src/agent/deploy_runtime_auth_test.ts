import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  getRequiredBrokerUrl,
  isAuthorizedBrokerWakeUp,
  resolveBrokerAuthToken,
} from "./deploy_runtime_auth.ts";

Deno.test("resolveBrokerAuthToken prefers the static broker token", async () => {
  const token = await resolveBrokerAuthToken({
    brokerUrl: "https://broker.example",
    oidcAudience: "https://broker.example",
    staticToken: "static-token",
    supportsOidc: () => true,
    issueIdToken: () => Promise.resolve("oidc-token"),
  });

  assertEquals(token, "static-token");
});

Deno.test("resolveBrokerAuthToken falls back to OIDC when no static token exists", async () => {
  const token = await resolveBrokerAuthToken({
    brokerUrl: "https://broker.example",
    oidcAudience: "https://broker.example",
    staticToken: null,
    supportsOidc: () => true,
    issueIdToken: () => Promise.resolve("oidc-token"),
  });

  assertEquals(token, "oidc-token");
});

Deno.test("resolveBrokerAuthToken fails when no auth path is available", async () => {
  await assertRejects(
    () =>
      resolveBrokerAuthToken({
        brokerUrl: "https://broker.example",
        oidcAudience: "https://broker.example",
        staticToken: null,
        supportsOidc: () => false,
      }),
    Error,
    "Set DENOCLAW_BROKER_TOKEN or DENOCLAW_API_TOKEN, or enable OIDC",
  );
});

Deno.test("getRequiredBrokerUrl validates missing env", () => {
  assertEquals(
    getRequiredBrokerUrl("https://broker.example"),
    "https://broker.example",
  );
});

Deno.test("getRequiredBrokerUrl rejects missing broker URL", () => {
  assertThrows(
    () => getRequiredBrokerUrl(undefined),
    Error,
    "Set DENOCLAW_BROKER_URL in the deployed agent environment",
  );
});

Deno.test("isAuthorizedBrokerWakeUp accepts matching bearer tokens", () => {
  const req = new Request("https://agent.example/tasks", {
    method: "POST",
    headers: { authorization: "Bearer static-token" },
  });

  assertEquals(isAuthorizedBrokerWakeUp(req, "static-token"), true);
  assertEquals(isAuthorizedBrokerWakeUp(req, "other-token"), false);
});
