import type { MemoryPort } from "./memory_port.ts";
import type { EmbedderPort } from "./embedder_port.ts";
import { Memory } from "./memory.ts";
import { log } from "../shared/log.ts";

export async function createEmbedder(): Promise<EmbedderPort> {
  const provider = Deno.env.get("EMBEDDER_PROVIDER") ?? "fastembed";
  if (provider === "ollama") {
    const { OllamaEmbedder } = await import("./embedders/ollama.ts");
    const url = Deno.env.get("OLLAMA_EMBED_URL");
    if (!url) throw new Error("OLLAMA_EMBED_URL required when EMBEDDER_PROVIDER=ollama");
    return new OllamaEmbedder(url, Deno.env.get("OLLAMA_EMBED_MODEL"));
  }
  try {
    const { MastraEmbedder } = await import("./embedders/mastra.ts");
    return new MastraEmbedder();
  } catch {
    log.warn("fastembed unavailable, falling back to noop embedder");
    const { NoopEmbedder } = await import("./embedders/noop.ts");
    return new NoopEmbedder();
  }
}

export async function createMemory(agentId: string, sessionId: string): Promise<MemoryPort> {
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (dbUrl) {
    try {
      const embedder = await createEmbedder();
      const { MastraMemory } = await import("./memory_mastra.ts");
      return new MastraMemory(agentId, sessionId, { connectionString: dbUrl, embedder });
    } catch (e) {
      log.warn("MastraMemory initialization failed, falling back to KV memory", e);
    }
  }
  return new Memory(sessionId);
}
