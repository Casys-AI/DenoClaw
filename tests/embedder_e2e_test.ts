/**
 * E2E tests for OllamaEmbedder against the real Ollama Cloud API.
 *
 * Requires OLLAMA_API_KEY to be set.
 * Run: OLLAMA_API_KEY=<key> deno test --allow-all tests/embedder_e2e_test.ts
 */

import "@std/dotenv/load";
import { assert, assertEquals } from "@std/assert";
import { OllamaEmbedder } from "../src/agent/memory/embedders/ollama.ts";

const OLLAMA_API_KEY = Deno.env.get("OLLAMA_API_KEY");
const skip = !OLLAMA_API_KEY;

const baseTestOpts = {
  sanitizeResources: false,
  sanitizeOps: false,
};

const OLLAMA_CLOUD_URL = "https://api.ollama.com";
const EMBED_MODEL = Deno.env.get("OLLAMA_EMBED_MODEL") ?? "nomic-embed-text";

// ── 1. embed returns non-empty vector ────────────────────────────────────────

Deno.test({
  name: "OllamaEmbedder E2E: embed('hello world') returns a non-empty array of numbers",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const embedder = new OllamaEmbedder(
      OLLAMA_CLOUD_URL,
      EMBED_MODEL,
      undefined,
      OLLAMA_API_KEY!,
    );

    const vector = await embedder.embed("hello world");

    assert(Array.isArray(vector), "embed should return an array");
    assert(vector.length > 0, `embed should return a non-empty vector, got length ${vector.length}`);
    for (const v of vector) {
      assert(typeof v === "number", `Each element should be a number, got ${typeof v}`);
      assert(isFinite(v), `Each element should be finite, got ${v}`);
    }
  },
});

// ── 2. embedBatch returns 2 vectors ──────────────────────────────────────────

Deno.test({
  name: "OllamaEmbedder E2E: embedBatch(['hello', 'world']) returns 2 vectors",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const embedder = new OllamaEmbedder(
      OLLAMA_CLOUD_URL,
      EMBED_MODEL,
      undefined,
      OLLAMA_API_KEY!,
    );

    const vectors = await embedder.embedBatch(["hello", "world"]);

    assert(Array.isArray(vectors), "embedBatch should return an array");
    assertEquals(vectors.length, 2, "embedBatch should return 2 vectors for 2 inputs");

    for (let i = 0; i < vectors.length; i++) {
      const vec = vectors[i];
      assert(Array.isArray(vec), `vectors[${i}] should be an array`);
      assert(
        vec.length > 0,
        `vectors[${i}] should be a non-empty vector, got length ${vec.length}`,
      );
      for (const v of vec) {
        assert(typeof v === "number", `vectors[${i}] element should be a number`);
        assert(isFinite(v), `vectors[${i}] element should be finite, got ${v}`);
      }
    }
  },
});

// ── 3. dimension is consistent with returned vector length ───────────────────

Deno.test({
  name: "OllamaEmbedder E2E: reported dimension matches actual vector length",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    // Default dimension for nomic-embed-text is 768
    const expectedDim = parseInt(Deno.env.get("OLLAMA_EMBED_DIM") ?? "768", 10);
    const embedder = new OllamaEmbedder(
      OLLAMA_CLOUD_URL,
      EMBED_MODEL,
      expectedDim,
      OLLAMA_API_KEY!,
    );

    const vector = await embedder.embed("dimension test");

    assertEquals(
      vector.length,
      expectedDim,
      `Returned vector length ${vector.length} should match configured dimension ${expectedDim}`,
    );
    assertEquals(
      embedder.dimension,
      expectedDim,
      "embedder.dimension should match configured value",
    );
  },
});
