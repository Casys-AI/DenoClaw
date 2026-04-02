import { assertEquals } from "@std/assert";
import { assertRejects } from "@std/assert";
import { OllamaEmbedder } from "./ollama.ts";

Deno.test({
  name: "OllamaEmbedder calls /api/embed with correct format",
  async fn() {
    const server = Deno.serve({ port: 0 }, () =>
      Response.json({
        model: "nomic-embed-text",
        embeddings: [[0.1, 0.2, 0.3]],
      })
    );
    const port = server.addr.port;
    const embedder = new OllamaEmbedder(`http://localhost:${port}`, "nomic-embed-text", 3);
    const result = await embedder.embed("hello");
    assertEquals(result, [0.1, 0.2, 0.3]);
    assertEquals(embedder.dimension, 3);
    await server.shutdown();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "OllamaEmbedder embedBatch returns multiple vectors",
  async fn() {
    const server = Deno.serve({ port: 0 }, () =>
      Response.json({ embeddings: [[0.1, 0.2], [0.3, 0.4]] })
    );
    const port = server.addr.port;
    const embedder = new OllamaEmbedder(`http://localhost:${port}`, "test", 2);
    const result = await embedder.embedBatch(["a", "b"]);
    assertEquals(result, [[0.1, 0.2], [0.3, 0.4]]);
    await server.shutdown();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "OllamaEmbedder.embed throws on non-ok response",
  async fn() {
    const server = Deno.serve({ port: 0 }, () =>
      new Response("model not found", { status: 404 })
    );
    const port = server.addr.port;
    const embedder = new OllamaEmbedder(`http://localhost:${port}`);
    await assertRejects(() => embedder.embed("test"), Error, "OLLAMA_EMBED_FAILED");
    await server.shutdown();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
