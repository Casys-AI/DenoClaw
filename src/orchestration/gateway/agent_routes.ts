import type { WorkerPool } from "../../agent/worker_pool.ts";
import type { AgentEntry } from "../../shared/types.ts";
import type { AgentStore } from "../agent_store.ts";

export interface GatewayAgentRoutesContext {
  agentStore: AgentStore | null;
  workerPool: Pick<WorkerPool, "addAgent" | "removeAgent">;
}

export async function handleGatewayAgentRoute(
  ctx: GatewayAgentRoutesContext,
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (!ctx.agentStore) return null;

  if (url.pathname === "/api/agents" && req.method === "GET") {
    return Response.json(await ctx.agentStore.list());
  }

  if (url.pathname === "/api/agents" && req.method === "POST") {
    try {
      const body = await req.json() as { agentId: string; config: AgentEntry };
      if (!body.agentId || !body.config) {
        return Response.json({
          error: {
            code: "INVALID_INPUT",
            recovery: "Provide agentId and config",
          },
        }, { status: 400 });
      }
      await ctx.agentStore.set(body.agentId, body.config);
      try {
        await ctx.workerPool.addAgent(body.agentId, body.config);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({
          ok: true,
          agentId: body.agentId,
          warning: "AGENT_START_SKIPPED",
          context: { cause: msg },
        });
      }
      return Response.json({ ok: true, agentId: body.agentId });
    } catch (error) {
      return Response.json({
        error: {
          code: "INVALID_JSON",
          context: { message: (error as Error).message },
        },
      }, { status: 400 });
    }
  }

  const agentId = extractAgentIdFromPath(url.pathname);
  if (!agentId) return null;

  if (req.method === "DELETE") {
    const deleted = await ctx.agentStore.delete(agentId);
    if (deleted) ctx.workerPool.removeAgent(agentId);
    return Response.json({ ok: deleted, agentId });
  }

  if (req.method === "GET") {
    const config = await ctx.agentStore.get(agentId);
    if (!config) {
      return Response.json({
        error: {
          code: "AGENT_NOT_FOUND",
          recovery: "Register the agent via POST /api/agents before querying it",
        },
      }, { status: 404 });
    }
    return Response.json({ agentId, config });
  }

  return null;
}

function extractAgentIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith("/api/agents/")) return null;
  const agentId = pathname.split("/api/agents/")[1];
  return agentId || null;
}
