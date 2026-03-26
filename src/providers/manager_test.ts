import { assertEquals, assertRejects } from "@std/assert";
import { ProviderManager } from "./manager.ts";
import { ProviderError } from "../utils/errors.ts";
import type { Config } from "../types.ts";

function makeConfig(overrides?: Partial<Config["providers"]>): Config {
  return {
    providers: { ...overrides },
    agents: { defaults: { model: "test", temperature: 0.7, maxTokens: 4096 } },
    tools: {},
    channels: {},
  };
}

Deno.test("ProviderManager resolves Ollama without API key", async () => {
  const pm = new ProviderManager(makeConfig());

  // Mock fetch for Ollama
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: "ollama response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })))) as typeof fetch;

  try {
    const result = await pm.complete(
      [{ role: "user", content: "test" }],
      "ollama/nemotron-3-super",
    );
    assertEquals(result.content, "ollama response");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("ProviderManager resolves nemotron prefix to Ollama", async () => {
  const pm = new ProviderManager(makeConfig());

  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    })))) as typeof fetch;

  try {
    const result = await pm.complete(
      [{ role: "user", content: "test" }],
      "nemotron-3-super",
    );
    assertEquals(result.content, "ok");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("ProviderManager throws NO_PROVIDER when no key", async () => {
  const pm = new ProviderManager(makeConfig());

  await assertRejects(
    () => pm.complete([{ role: "user", content: "test" }], "anthropic/claude-sonnet-4-6"),
    ProviderError,
  );
});

Deno.test("ProviderManager resolves Anthropic with key", async () => {
  const pm = new ProviderManager(makeConfig({ anthropic: { apiKey: "test-key" } }));

  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({
      content: [{ type: "text", text: "claude response" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })))) as typeof fetch;

  try {
    const result = await pm.complete(
      [{ role: "user", content: "test" }],
      "anthropic/claude-sonnet-4-6",
    );
    assertEquals(result.content, "claude response");
  } finally {
    globalThis.fetch = original;
  }
});
