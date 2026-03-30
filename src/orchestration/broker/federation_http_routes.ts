import type { BrokerIdentity } from "../federation/mod.ts";
import {
  type FederatedRoutePolicy,
  FederationDeadLetterNotFoundError,
  type FederationService,
  type KvFederationAdapter,
} from "../federation/mod.ts";

export interface BrokerFederationHttpContext {
  getFederationAdapter(): Promise<KvFederationAdapter>;
  getFederationService(): Promise<FederationService>;
}

export async function handleBrokerFederationHttpRoute(
  ctx: BrokerFederationHttpContext,
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/federation/links") {
    const adapter = await ctx.getFederationAdapter();
    return Response.json(await adapter.listLinks());
  }

  if (req.method === "GET" && url.pathname === "/federation/catalog") {
    const remoteBrokerId = url.searchParams.get("remoteBrokerId");
    if (!remoteBrokerId) {
      return Response.json(
        {
          error: {
            code: "MISSING_REMOTE_BROKER_ID",
            recovery: "Add ?remoteBrokerId=<broker-id>",
          },
        },
        { status: 400 },
      );
    }
    const adapter = await ctx.getFederationAdapter();
    return Response.json(
      await adapter.listRemoteAgents(remoteBrokerId, {
        remoteBrokerId,
        traceId: crypto.randomUUID(),
      }),
    );
  }

  if (req.method === "GET" && url.pathname === "/federation/stats") {
    const remoteBrokerId = url.searchParams.get("remoteBrokerId") ?? undefined;
    const adapter = await ctx.getFederationAdapter();
    return Response.json(await adapter.getFederationStats(remoteBrokerId));
  }

  if (req.method === "GET" && url.pathname === "/federation/dead-letters") {
    const remoteBrokerId = url.searchParams.get("remoteBrokerId") ?? undefined;
    const adapter = await ctx.getFederationAdapter();
    const deadLetters = await adapter.listDeadLetters(remoteBrokerId);
    deadLetters.sort((left, right) =>
      right.movedAt.localeCompare(left.movedAt)
    );
    return Response.json(deadLetters);
  }

  if (
    req.method === "POST" &&
    url.pathname === "/federation/dead-letter/replay"
  ) {
    const body = (await req.json().catch(() => null)) as {
      remoteBrokerId?: string;
      deadLetterId?: string;
      maxAttempts?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
    } | null;
    const invalidAttempts = body?.maxAttempts !== undefined &&
      (!Number.isInteger(body.maxAttempts) || body.maxAttempts <= 0);
    const invalidBaseBackoff = body?.baseBackoffMs !== undefined &&
      (!Number.isFinite(body.baseBackoffMs) || body.baseBackoffMs < 0);
    const invalidMaxBackoff = body?.maxBackoffMs !== undefined &&
      (!Number.isFinite(body.maxBackoffMs) || body.maxBackoffMs < 0);
    const invalidBackoffRange = body?.baseBackoffMs !== undefined &&
      body?.maxBackoffMs !== undefined &&
      body.baseBackoffMs > body.maxBackoffMs;
    if (
      !body ||
      typeof body.remoteBrokerId !== "string" ||
      body.remoteBrokerId.length === 0 ||
      typeof body.deadLetterId !== "string" ||
      body.deadLetterId.length === 0 ||
      invalidAttempts ||
      invalidBaseBackoff ||
      invalidMaxBackoff ||
      invalidBackoffRange
    ) {
      return Response.json(
        {
          error: {
            code: "INVALID_DEAD_LETTER_REPLAY_REQUEST",
            recovery:
              "Provide { remoteBrokerId, deadLetterId, maxAttempts?, baseBackoffMs?, maxBackoffMs? } with positive numeric overrides",
          },
        },
        { status: 400 },
      );
    }

    const service = await ctx.getFederationService();
    const traceId = crypto.randomUUID();
    try {
      const result = await service.replayDeadLetter({
        remoteBrokerId: body.remoteBrokerId,
        deadLetterId: body.deadLetterId,
        traceId,
        maxAttempts: body.maxAttempts,
        baseBackoffMs: body.baseBackoffMs,
        maxBackoffMs: body.maxBackoffMs,
      });
      return Response.json({ ok: true, traceId, result });
    } catch (error) {
      if (error instanceof FederationDeadLetterNotFoundError) {
        return Response.json(
          {
            error: {
              code: "FEDERATION_DEAD_LETTER_NOT_FOUND",
              recovery: "Refresh the dead-letter list and retry replay",
            },
          },
          { status: 404 },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(
        {
          error: {
            code: "FEDERATION_DEAD_LETTER_REPLAY_FAILED",
            cause: message,
            recovery:
              "Inspect the dead-letter entry and broker logs before retrying",
          },
        },
        { status: 500 },
      );
    }
  }

  if (req.method === "GET" && url.pathname === "/federation/policy") {
    const brokerId = url.searchParams.get("brokerId");
    if (!brokerId) {
      return Response.json(
        {
          error: {
            code: "MISSING_BROKER_ID",
            recovery: "Add ?brokerId=<broker-id>",
          },
        },
        { status: 400 },
      );
    }
    const adapter = await ctx.getFederationAdapter();
    return Response.json(
      await adapter.getRoutePolicy(brokerId, {
        remoteBrokerId: brokerId,
        traceId: crypto.randomUUID(),
      }),
    );
  }

  if (req.method === "PUT" && url.pathname === "/federation/policy") {
    const body = (await req.json().catch(() => null)) as
      | FederatedRoutePolicy
      | null;
    if (
      !body ||
      typeof body.policyId !== "string" ||
      body.policyId.length === 0
    ) {
      return Response.json(
        {
          error: {
            code: "INVALID_POLICY",
            recovery: "Provide a valid FederatedRoutePolicy JSON body",
          },
        },
        { status: 400 },
      );
    }
    const adapter = await ctx.getFederationAdapter();
    await adapter.setRoutePolicy(body.policyId, body, {
      remoteBrokerId: body.policyId,
      traceId: crypto.randomUUID(),
    });
    return Response.json({ ok: true, policyId: body.policyId });
  }

  if (req.method === "GET" && url.pathname === "/federation/identities") {
    const service = await ctx.getFederationService();
    return Response.json(await service.listIdentities());
  }

  if (req.method === "GET" && url.pathname === "/federation/identity") {
    const brokerId = url.searchParams.get("brokerId");
    if (!brokerId) {
      return Response.json(
        {
          error: {
            code: "MISSING_BROKER_ID",
            recovery: "Add ?brokerId=<broker-id>",
          },
        },
        { status: 400 },
      );
    }
    const service = await ctx.getFederationService();
    return Response.json(await service.getIdentity(brokerId));
  }

  if (req.method === "PUT" && url.pathname === "/federation/identity") {
    const body = (await req.json().catch(() => null)) as BrokerIdentity | null;
    if (
      !body ||
      typeof body.brokerId !== "string" ||
      body.brokerId.length === 0
    ) {
      return Response.json(
        {
          error: {
            code: "INVALID_IDENTITY",
            recovery: "Provide a valid BrokerIdentity JSON body",
          },
        },
        { status: 400 },
      );
    }
    const service = await ctx.getFederationService();
    await service.upsertIdentity(body);
    return Response.json({ ok: true, brokerId: body.brokerId });
  }

  if (req.method === "DELETE" && url.pathname === "/federation/identity") {
    const brokerId = url.searchParams.get("brokerId");
    if (!brokerId) {
      return Response.json(
        {
          error: {
            code: "MISSING_BROKER_ID",
            recovery: "Add ?brokerId=<broker-id>",
          },
        },
        { status: 400 },
      );
    }
    const service = await ctx.getFederationService();
    await service.revokeIdentity(brokerId);
    return Response.json({ ok: true, brokerId });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/federation/identity/rotate"
  ) {
    const body = (await req.json().catch(() => null)) as {
      brokerId?: string;
      nextPublicKey?: string;
    } | null;
    if (
      !body ||
      typeof body.brokerId !== "string" ||
      body.brokerId.length === 0 ||
      typeof body.nextPublicKey !== "string" ||
      body.nextPublicKey.length === 0
    ) {
      return Response.json(
        {
          error: {
            code: "INVALID_ROTATE_IDENTITY_REQUEST",
            recovery: "Provide { brokerId, nextPublicKey }",
          },
        },
        { status: 400 },
      );
    }

    const service = await ctx.getFederationService();
    const identity = await service.rotateIdentityKey(
      body.brokerId,
      body.nextPublicKey,
    );
    return Response.json({ ok: true, identity });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/federation/session/rotate"
  ) {
    const body = (await req.json().catch(() => null)) as {
      linkId?: string;
      ttlSeconds?: number;
    } | null;
    const invalidTtl = body?.ttlSeconds !== undefined &&
      (!Number.isFinite(body.ttlSeconds) || body.ttlSeconds <= 0);
    if (
      !body ||
      typeof body.linkId !== "string" ||
      body.linkId.length === 0 ||
      invalidTtl
    ) {
      return Response.json(
        {
          error: {
            code: "INVALID_ROTATE_SESSION_REQUEST",
            recovery: "Provide { linkId, ttlSeconds? } with ttlSeconds > 0",
          },
        },
        { status: 400 },
      );
    }
    const service = await ctx.getFederationService();
    const adapter = await ctx.getFederationAdapter();
    const link = (await adapter.listLinks()).find((entry) =>
      entry.linkId === body.linkId
    );
    if (!link) {
      return Response.json(
        {
          error: {
            code: "FEDERATION_LINK_NOT_FOUND",
            recovery: "Create the link before rotating its session",
          },
        },
        { status: 404 },
      );
    }
    const session = await service.rotateLinkSession(
      {
        linkId: body.linkId,
        remoteBrokerId: link.remoteBrokerId,
        traceId: crypto.randomUUID(),
      },
      typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined,
    );
    return Response.json({ ok: true, session });
  }

  return null;
}
