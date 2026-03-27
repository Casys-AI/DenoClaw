import { assertEquals, assertRejects } from "@std/assert";
import { ProviderManager } from "./manager.ts";
import { ProviderError } from "../shared/errors.ts";
import type { ProvidersConfig } from "./types.ts";

function makeProviders(overrides?: Partial<ProvidersConfig>): ProvidersConfig {
  return { ...overrides };
}

Deno.test("ProviderManager resolves Ollama with API key", async () => {
  const pm = new ProviderManager(
    makeProviders({ ollama: { apiKey: "ollama-key" } }),
  );

  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({
        model: "nemotron-3-super",
        message: { role: "assistant", content: "ollama response" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
      })),
    )) as typeof fetch;

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
  const pm = new ProviderManager(makeProviders({ ollama: { apiKey: "key" } }));

  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({
        model: "nemotron-3-super",
        message: { role: "assistant", content: "ok" },
        done: true,
      })),
    )) as typeof fetch;

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
  const pm = new ProviderManager(makeProviders());

  await assertRejects(
    () =>
      pm.complete(
        [{ role: "user", content: "test" }],
        "anthropic/claude-sonnet-4-6",
      ),
    ProviderError,
  );
});

Deno.test("ProviderManager resolves Anthropic with key", async () => {
  const pm = new ProviderManager(
    makeProviders({ anthropic: { apiKey: "test-key" } }),
  );

  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({
        content: [{ type: "text", text: "claude response" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    )) as typeof fetch;

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
