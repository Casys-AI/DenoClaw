import type { MemoryPort } from "./memory_port.ts";
import type { EmbedderPort } from "./embedder_port.ts";
import { Memory } from "./memory.ts";
import { log } from "../shared/log.ts";

export async function createEmbedder(): Promise<EmbedderPort> {
  const provider = Deno.env.get("EMBEDDER_PROVIDER") ?? "fastembed";
  if (provider === "ollama") {
    const { OllamaEmbedder } = await import("./embedders/ollama.ts");
    // Same Ollama Cloud instance as the LLM provider
    const url = Deno.env.get("OLLAMA_EMBED_URL") ?? "https://api.ollama.com";
    const apiKey = Deno.env.get("OLLAMA_API_KEY");
    const model = Deno.env.get("OLLAMA_EMBED_MODEL") ?? "nomic-embed-text";
    const dim = Deno.env.get("OLLAMA_EMBED_DIM");
    return new OllamaEmbedder(url, model, dim ? parseInt(dim, 10) : undefined, apiKey);
  }
  try {
    const { MastraEmbedder } = await import("./embedders/mastra.ts");
    return new MastraEmbedder();
  } catch (e) {
    log.error(
      "fastembed (MastraEmbedder) failed to load — falling back to noop embedder. " +
        "Semantic recall will be disabled.",
      e,
    );
    const { NoopEmbedder } = await import("./embedders/noop.ts");
    return new NoopEmbedder();
  }
}

export async function createMemory(
  agentId: string,
  sessionId: string,
  kvPath?: string,
): Promise<MemoryPort> {
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (dbUrl) {
    // No silent fallback — if DATABASE_URL is set, Postgres must work
    const embedder = await createEmbedder();
    const { MastraMemory } = await import("./memory_mastra.ts");
    const mem = new MastraMemory(agentId, sessionId, { connectionString: dbUrl, embedder });
    await mem.load();
    return mem;
  }
  const mem = new Memory(sessionId, 100, kvPath);
  await mem.load();
  return mem;
}
