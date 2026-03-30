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
    getConfig: async () => config,
    getConfigOrDefault: async () => config,
    createAgent: async () => {},
    deleteAgent: async () => {},
    listAgents: async () => {},
    printHelp: () => {},
    initCliFlags,
    runInitWizard: async () => {},
    setupProvider: async () => {},
    setupChannel: async () => {},
    setupAgent: async () => {},
    deployBroker: async () => {},
    publishAgent: async () => {},
    showStatus: async () => {},
    startAgentRuntime: async () => {},
    startLocalGateway: async () => {},
    startBrokerRuntime: async () => {},
    startLocalTunnel: async () => {},
    humanLog,
    humanWarn,
    outputError,
    streamBrokerLogs: async () => {},
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
    setupProvider: async () => {
      called = true;
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
    deleteAgent: async (_name, opts) => {
      receivedYes = opts?.yes;
    },
  });

  await runCli(["agent", "delete", "alice", "--yes"], deps);

  assertEquals(receivedYes, true);
});
