import type { MemoryPort } from "./port.ts";
import type { EmbedderPort } from "./embedder_port.ts";
import { KvdexMemory } from "./kvdex.ts";
import { log } from "../../shared/log.ts";

export async function createEmbedder(): Promise<EmbedderPort> {
  const provider = Deno.env.get("EMBEDDER_PROVIDER") ?? "fastembed";
  if (provider === "ollama") {
    const { OllamaEmbedder } = await import("./embedders/ollama.ts");
    const url = Deno.env.get("OLLAMA_EMBED_URL") ?? "https://api.ollama.com";
    const apiKey = Deno.env.get("OLLAMA_API_KEY");
    const model = Deno.env.get("OLLAMA_EMBED_MODEL") ?? "nomic-embed-text";
    const dim = Deno.env.get("OLLAMA_EMBED_DIM");
    return new OllamaEmbedder(url, model, dim ? parseInt(dim, 10) : undefined, apiKey);
  }
  if (provider === "none") {
    const { NoopEmbedder } = await import("./embedders/noop.ts");
    return new NoopEmbedder();
  }
  // Default: fastembed (local FFI/ONNX)
  const { MastraEmbedder } = await import("./embedders/mastra.ts");
  return new MastraEmbedder();
}

export async function createMemory(
  agentId: string,
  sessionId: string,
  kvPath?: string,
): Promise<MemoryPort> {
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (dbUrl) {
    const embedder = await createEmbedder();
    const { MastraMemory } = await import("./mastra.ts");
    const mem = new MastraMemory(agentId, sessionId, { connectionString: dbUrl, embedder });
    await mem.load();
    log.info(`MastraMemory initialized for ${agentId}:${sessionId}`);
    return mem;
  }
  // Local dev: KvdexMemory with per-agent KV isolation
  const mem = new KvdexMemory(agentId, sessionId, 100, kvPath);
  await mem.load();
  return mem;
}
