import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Config } from "../config/types.ts";
import {
  createDeployApiHeaders,
  createDeployEnvVars,
  deployAppRevision,
  deriveDeployAppSlug,
  ensureDeployApp,
  getDeployAppEndpoint,
  registerAgentEndpointWithBroker,
  resolveBrokerUrl,
} from "./deploy_api.ts";

Deno.test("deriveDeployAppSlug normalizes agent ids", () => {
  assertEquals(deriveDeployAppSlug(" Alice / Builder "), "alice-builder");
});

Deno.test("resolveBrokerUrl prefers env over config", () => {
  const original = Deno.env.get("DENOCLAW_BROKER_URL");
  try {
    Deno.env.set("DENOCLAW_BROKER_URL", "https://env.example");
    const config = {
      deploy: { url: "https://config.example", app: "broker-app" },
    } as Config;
    assertEquals(resolveBrokerUrl(config), "https://env.example");
  } finally {
    if (original) Deno.env.set("DENOCLAW_BROKER_URL", original);
    else Deno.env.delete("DENOCLAW_BROKER_URL");
  }
});

Deno.test("resolveBrokerUrl falls back to deploy app hostname", () => {
  const original = Deno.env.get("DENOCLAW_BROKER_URL");
  try {
    Deno.env.delete("DENOCLAW_BROKER_URL");
    const config = { deploy: { app: "denoclaw", org: "casys" } } as Config;
    assertEquals(resolveBrokerUrl(config), "https://denoclaw.casys.deno.net");
  } finally {
    if (original) Deno.env.set("DENOCLAW_BROKER_URL", original);
  }
});

Deno.test("createDeployApiHeaders builds bearer auth headers", () => {
  assertEquals(createDeployApiHeaders("ddo_test"), {
    Authorization: "Bearer ddo_test",
    "Content-Type": "application/json",
  });
});

Deno.test("createDeployEnvVars filters undefined values", () => {
  assertEquals(
    createDeployEnvVars({ A: "1", B: undefined, C: "3" }),
    [{ key: "A", value: "1" }, { key: "C", value: "3" }],
  );
});

Deno.test("getDeployAppEndpoint returns the app hostname", () => {
  assertEquals(
    getDeployAppEndpoint({ id: "app_123", slug: "agent-alice" }, "casys"),
    "https://agent-alice.casys.deno.net",
  );
  assertEquals(
    getDeployAppEndpoint({ id: "app_123", slug: "agent-alice" }),
    "https://agent-alice.deno.dev",
  );
});

Deno.test("ensureDeployApp reuses an existing app", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = ((input: string | URL | Request) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "app_123",
          slug: "agent-alice",
          labels: { "custom.denoclaw.agent_id": "alice" },
        }),
      ),
    );
  }) as typeof fetch;

  try {
    const app = await ensureDeployApp("alice", createDeployApiHeaders("ddo"));
    assertEquals(app, { id: "app_123", slug: "agent-alice" });
    assertEquals(requestedUrl, "https://api.deno.com/v2/apps/alice");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ensureDeployApp creates a new app after a 404 lookup", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if (calls.length === 1) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "app_456",
          slug: "alice",
        }),
        { status: 201 },
      ),
    );
  }) as typeof fetch;

  try {
    const app = await ensureDeployApp("alice", createDeployApiHeaders("ddo"));
    assertEquals(app, { id: "app_456", slug: "alice" });
    assertEquals(calls[0]?.url, "https://api.deno.com/v2/apps/alice");
    assertEquals(calls[1]?.url, "https://api.deno.com/v2/apps");
    assertEquals(calls[1]?.method, "POST");
    assertStringIncludes(calls[1]?.body ?? "", '"slug":"alice"');
    assertStringIncludes(
      calls[1]?.body ?? "",
      '"custom.denoclaw.agent_id":"alice"',
    );
    assertStringIncludes(
      calls[1]?.body ?? "",
      '"entrypoint":"main.ts"',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  "ensureDeployApp rejects an existing slug bound to another agent",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "app_789",
            slug: "alice",
            labels: { "custom.denoclaw.agent_id": "bob" },
          }),
        ),
      )) as typeof fetch;

    try {
      await assertRejects(
        () => ensureDeployApp("alice", createDeployApiHeaders("ddo")),
        Error,
        "already assigned to agent",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "deployAppRevision posts assets and env vars to the deploy endpoint",
  async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = (
      (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          new Response(JSON.stringify({ id: "rev_123" }), { status: 201 }),
        );
      }
    ) as typeof fetch;

    try {
      const revision = await deployAppRevision({
        app: { id: "app_123", slug: "alice" },
        assets: {
          "main.ts": {
            kind: "file",
            encoding: "utf-8",
            content: "Deno.serve(() => new Response('ok'));",
          },
        },
        envVars: [{ key: "DENOCLAW_AGENT_ID", value: "alice" }],
        headers: createDeployApiHeaders("ddo"),
      });

      assertEquals(revision, { id: "rev_123" });
      assertEquals(capturedUrl, "https://api.deno.com/v2/apps/alice/deploy");
      assertStringIncludes(capturedBody, '"production":true');
      assertStringIncludes(capturedBody, '"DENOCLAW_AGENT_ID"');
      assertStringIncludes(capturedBody, '"main.ts"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "registerAgentEndpointWithBroker rejects broker registration failures",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("forbidden", { status: 403 }),
      )) as typeof fetch;

    try {
      await assertRejects(
        () =>
          registerAgentEndpointWithBroker({
            brokerUrl: "https://broker.example",
            authToken: "token",
            agentId: "alice",
            endpoint: "https://alice.deno.dev",
            config: { model: "gpt-5" },
          }),
        Error,
        "Broker registration failed (403)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
