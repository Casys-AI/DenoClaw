import { assertEquals, assertRejects } from "@std/assert";
import { OpenAICompatProvider } from "./base.ts";
import { ProviderError } from "../shared/errors.ts";

Deno.test("OpenAICompatProvider strips provider prefix from model name", async () => {
  // We can't call a real API, but we can test that it builds the right request
  // by catching the fetch and inspecting the body
  // deno-lint-ignore no-explicit-any
  let capturedBody: any = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{
        message: { content: "ok", tool_calls: null },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatProvider("fake-key", "https://fake.api/v1");
    const result = await provider.complete(
      [{ role: "user", content: "test" }],
      "openai/gpt-4o",
    );

    assertEquals(result.content, "ok");
    assertEquals(result.finishReason, "stop");
    assertEquals(result.usage?.totalTokens, 15);
    assertEquals(capturedBody?.model, "gpt-4o"); // prefix stripped
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Provider throws ProviderError on HTTP failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatProvider("fake-key", "https://fake.api/v1");
    await assertRejects(
      () => provider.complete([{ role: "user", content: "test" }], "gpt-4o"),
      ProviderError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
