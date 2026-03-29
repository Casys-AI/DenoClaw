import type { FreshContext } from "@fresh/core";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../../lib/dashboard-auth.ts";

/**
 * SSE proxy — the browser connects here (same origin),
 * and the gateway SSE stream is relayed server-side. Zero CORS.
 */
export const handler = {
  GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const config = getDashboardRequestConfig(ctx.req);
    const headers: HeadersInit = config.token
      ? { "Authorization": `Bearer ${config.token}` }
      : {};

    const body = new ReadableStream({
      async start(controller) {
        try {
          const res = await fetch(`${config.brokerUrl}/events`, { headers });
          if (!res.ok || !res.body) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: {"type":"error","detail":"Gateway unreachable"}\n\n`,
              ),
            );
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
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"type":"error","detail":"Connection failed"}\n\n`,
            ),
          );
        } finally {
          try {
            controller.close();
          } catch { /* already closed */ }
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

export default function ApiEvents() {
  return null;
}
