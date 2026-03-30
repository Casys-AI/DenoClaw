export function federationCatalogKey(remoteBrokerId: string): Deno.KvKey {
  return ["federation", "catalog", remoteBrokerId];
}

export function federationDeadLetterKey(
  remoteBrokerId: string,
  deadLetterId: string,
): Deno.KvKey {
  return ["federation", "dead-letter", remoteBrokerId, deadLetterId];
}

export function federationDeadLetterPrefix(
  remoteBrokerId?: string,
): Deno.KvKey {
  return remoteBrokerId
    ? ["federation", "dead-letter", remoteBrokerId]
    : ["federation", "dead-letter"];
}

export function federationDenialEventKey(
  remoteBrokerId: string,
  eventId = crypto.randomUUID(),
): Deno.KvKey {
  return ["federation", "denials", remoteBrokerId, eventId];
}

export function federationDenialPrefix(): Deno.KvKey {
  return ["federation", "denials"];
}

export function federationHopEventKey(
  taskId: string,
  eventId = crypto.randomUUID(),
): Deno.KvKey {
  return ["federation", "events", taskId, eventId];
}

export function federationHopEventPrefix(): Deno.KvKey {
  return ["federation", "events"];
}

export function federationIdentityKey(brokerId: string): Deno.KvKey {
  return ["federation", "identity", brokerId];
}

export function federationIdentityPrefix(): Deno.KvKey {
  return ["federation", "identity"];
}

export function federationLinkKey(linkId: string): Deno.KvKey {
  return ["federation", "links", linkId];
}

export function federationLinkStatsKey(
  remoteBrokerId: string,
  linkId: string,
): Deno.KvKey {
  return ["federation", "stats", "links", remoteBrokerId, linkId];
}

export function federationLinkStatsPrefix(
  remoteBrokerId?: string,
): Deno.KvKey {
  return remoteBrokerId
    ? ["federation", "stats", "links", remoteBrokerId]
    : ["federation", "stats", "links"];
}

export function federationLinksPrefix(): Deno.KvKey {
  return ["federation", "links"];
}

export function federationPolicyKey(brokerId: string): Deno.KvKey {
  return ["federation", "policies", brokerId];
}

export function federationSessionKey(
  linkId: string,
  sessionId: string,
): Deno.KvKey {
  return ["federation", "sessions", linkId, sessionId];
}

export function federationStatsSummaryKey(remoteBrokerId?: string): Deno.KvKey {
  return remoteBrokerId
    ? ["federation", "stats", "summary", remoteBrokerId]
    : ["federation", "stats", "summary"];
}

export function federationSubmissionKey(idempotencyKey: string): Deno.KvKey {
  return ["federation", "submissions", idempotencyKey];
}
