import { assertEquals } from "@std/assert";
import { assertRejects } from "@std/assert";
import { createMemory, createEmbedder } from "./memory_factory.ts";
import { Memory } from "./memory.ts";

Deno.test({
  name: "createMemory returns Memory when DATABASE_URL is absent",
  async fn() {
    const orig = Deno.env.get("DATABASE_URL");
    Deno.env.delete("DATABASE_URL");
    try {
      const mem = await createMemory("agent-1", "sess-1");
      assertEquals(mem instanceof Memory, true);
      mem.close();
    } finally {
      if (orig) Deno.env.set("DATABASE_URL", orig);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "createEmbedder throws when EMBEDDER_PROVIDER=ollama and OLLAMA_EMBED_URL missing",
  async fn() {
    const origProvider = Deno.env.get("EMBEDDER_PROVIDER");
    const origUrl = Deno.env.get("OLLAMA_EMBED_URL");
    Deno.env.set("EMBEDDER_PROVIDER", "ollama");
    Deno.env.delete("OLLAMA_EMBED_URL");
    try {
      await assertRejects(() => createEmbedder(), Error, "OLLAMA_EMBED_URL required");
    } finally {
      if (origProvider) Deno.env.set("EMBEDDER_PROVIDER", origProvider);
      else Deno.env.delete("EMBEDDER_PROVIDER");
      if (origUrl) Deno.env.set("OLLAMA_EMBED_URL", origUrl);
    }
  },
});
