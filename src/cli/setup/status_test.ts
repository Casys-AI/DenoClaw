import { assertEquals } from "@std/assert";
import type { Config } from "../../config/types.ts";
import { initCliFlags } from "../output.ts";
import { showStatus } from "./status.ts";

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

Deno.test("showStatus emits only structured output in JSON mode", async () => {
  initCliFlags({ json: true }, { isTTY: true });

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await showStatus(createConfig());
  } finally {
    console.log = originalLog;
  }

  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), {
    providers: [],
    model: "test/model",
    channels: [],
    routeScopes: 0,
    deploy: null,
  });
});
