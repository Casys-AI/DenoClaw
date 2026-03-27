import { getBrokerUrl } from "../../lib/api-client.ts";

/**
 * SSE proxy — le browser se connecte ici (meme origine),
 * et on relaie le SSE de la gateway cote serveur. Zero CORS.
 */
export const handler = {
  GET(_req: Request) {
    const brokerUrl = getBrokerUrl();
    const token = Deno.env.get("DENOCLAW_API_TOKEN") || "";
    const headers: HeadersInit = token ? { "Authorization": `Bearer ${token}` } : {};

    const body = new ReadableStream({
      async start(controller) {
        try {
          const res = await fetch(`${brokerUrl}/events`, { headers });
          if (!res.ok || !res.body) {
            controller.enqueue(new TextEncoder().encode(`data: {"type":"error","detail":"Gateway unreachable"}\n\n`));
            controller.close();
            return;
          }
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch {
          controller.enqueue(new TextEncoder().encode(`data: {"type":"error","detail":"Connection failed"}\n\n`));
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  },
};

export default function ApiEvents() { return null; }
