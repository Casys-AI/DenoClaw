import { assertEquals } from "@std/assert";
import type { Config } from "../config/types.ts";
import type { CliCommandDeps } from "./entry.ts";
import { runCli } from "./entry.ts";
import { humanLog, humanWarn, initCliFlags, outputError } from "./output.ts";

function createConfig(): Config {
  return {
    providers: {},
    agents: {
      defaults: {
        model: "test/model",
        temperature: 0.2,
        maxTokens: 256,
      },
      registry: {},
    },
    tools: {},
    channels: {},
  };
}

function createCliDeps(
  overrides: Partial<CliCommandDeps> = {},
): CliCommandDeps {
  const config = createConfig();
  return {
    getConfig: () => Promise.resolve(config),
    getConfigOrDefault: () => Promise.resolve(config),
    createAgent: () => Promise.resolve(),
    deleteAgent: () => Promise.resolve(),
    listAgents: () => Promise.resolve(),
    printHelp: () => {},
    initCliFlags,
    runInitWizard: () => Promise.resolve(),
    setupProvider: () => Promise.resolve(),
    setupChannel: () => Promise.resolve(),
    setupChannelRoute: () => Promise.resolve(),
    listChannelRoutes: () => Promise.resolve(),
    deleteChannelRoute: () => Promise.resolve(),
    discoverChannelRoutes: () => Promise.resolve(),
    setupAgentDefaults: () => Promise.resolve(),
    publishAgents: () => Promise.resolve(),
    publishDeprecatedAgent: () => Promise.resolve(),
    deployBroker: () => Promise.resolve(),
    showStatus: () => Promise.resolve(),
    startAgentRuntime: () => Promise.resolve(),
    startLocalGateway: () => Promise.resolve(),
    startBrokerRuntime: () => Promise.resolve(),
    startLocalTunnel: () => Promise.resolve(),
    humanLog,
    humanWarn,
    outputError,
    streamBrokerLogs: () => Promise.resolve(),
    ...overrides,
  };
}

function captureConsoleLogAsync(fn: () => Promise<void>): {
  lines: string[];
  done: Promise<void>;
} {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const done = fn().finally(() => {
    console.log = original;
  });
  return { lines, done };
}

Deno.test("runCli suppresses deprecated setup warnings in JSON mode", async () => {
  let called = false;
  const deps = createCliDeps({
    setupProvider: () => {
      called = true;
      return Promise.resolve();
    },
  });

  const captured = captureConsoleLogAsync(() =>
    runCli(["setup", "provider", "--json"], deps)
  );
  await captured.done;

  assertEquals(called, true);
  assertEquals(captured.lines, []);
});

Deno.test("runCli forwards --yes to agent delete", async () => {
  let receivedYes: boolean | undefined;
  const deps = createCliDeps({
    deleteAgent: (_name, opts) => {
      receivedYes = opts?.yes;
      return Promise.resolve();
    },
  });

  await runCli(["agent", "delete", "alice", "--yes"], deps);

  assertEquals(receivedYes, true);
});

Deno.test("runCli dispatches channel route to setupChannelRoute", async () => {
  let called = false;
  const deps = createCliDeps({
    setupChannelRoute: () => {
      called = true;
      return Promise.resolve();
    },
  });

  await runCli(["channel", "route"], deps);

  assertEquals(called, true);
});

Deno.test("runCli dispatches channel route list", async () => {
  let called = false;
  const deps = createCliDeps({
    listChannelRoutes: () => {
      called = true;
      return Promise.resolve();
    },
  });

  await runCli(["channel", "route", "list"], deps);

  assertEquals(called, true);
});

Deno.test("runCli dispatches channel route delete", async () => {
  let called = false;
  const deps = createCliDeps({
    deleteChannelRoute: () => {
      called = true;
      return Promise.resolve();
    },
  });

  await runCli(["channel", "route", "delete"], deps);

  assertEquals(called, true);
});

Deno.test("runCli dispatches channel route discover", async () => {
  let called = false;
  const deps = createCliDeps({
    discoverChannelRoutes: () => {
      called = true;
      return Promise.resolve();
    },
  });

  await runCli(["channel", "route", "discover"], deps);

  assertEquals(called, true);
});

Deno.test("runCli dispatches publish to canonical publishAgents", async () => {
  let receivedTarget: string | undefined;
  let receivedForce = false;
  const deps = createCliDeps({
    publishAgents: (target, options) => {
      receivedTarget = target;
      receivedForce = !!options?.force;
      return Promise.resolve();
    },
  });

  await runCli(["publish", "alice", "--force"], deps);

  assertEquals(receivedTarget, "alice");
  assertEquals(receivedForce, true);
});

Deno.test("runCli dispatches deprecated deploy agent through publish wrapper", async () => {
  let receivedTarget: string | undefined;
  let receivedForce = false;
  const deps = createCliDeps({
    publishDeprecatedAgent: (target, options) => {
      receivedTarget = target;
      receivedForce = !!options?.force;
      return Promise.resolve();
    },
  });

  await runCli(["deploy", "agent", "alice", "--force"], deps);

  assertEquals(receivedTarget, "alice");
  assertEquals(receivedForce, true);
});
