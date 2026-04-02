import { assertEquals } from "@std/assert";
import { createMemory, createEmbedder } from "./factory.ts";
import { KvdexMemory } from "./kvdex.ts";

Deno.test({
  name: "createMemory returns KvdexMemory when DATABASE_URL is absent",
  async fn() {
    const orig = Deno.env.get("DATABASE_URL");
    Deno.env.delete("DATABASE_URL");
    try {
      const mem = await createMemory("agent-1", "sess-1");
      assertEquals(mem instanceof KvdexMemory, true);
      mem.close();
    } finally {
      if (orig) Deno.env.set("DATABASE_URL", orig);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "createEmbedder returns OllamaEmbedder with default cloud URL when OLLAMA_EMBED_URL absent",
  async fn() {
    const origProvider = Deno.env.get("EMBEDDER_PROVIDER");
    const origUrl = Deno.env.get("OLLAMA_EMBED_URL");
    Deno.env.set("EMBEDDER_PROVIDER", "ollama");
    Deno.env.delete("OLLAMA_EMBED_URL");
    try {
      const embedder = await createEmbedder();
      assertEquals(embedder.modelName, "nomic-embed-text");
    } finally {
      if (origProvider) Deno.env.set("EMBEDDER_PROVIDER", origProvider);
      else Deno.env.delete("EMBEDDER_PROVIDER");
      if (origUrl) Deno.env.set("OLLAMA_EMBED_URL", origUrl);
    }
  },
});
