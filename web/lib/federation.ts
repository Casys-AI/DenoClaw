import type { FederationLinkStats, FederationStatsSnapshot } from "./types.ts";

export interface FederationDenialTotals {
  policy: number;
  auth: number;
  notFound: number;
}

export function selectLatestFederationLink(
  snapshot: FederationStatsSnapshot | null,
): FederationLinkStats | null {
  if (!snapshot) return null;
  let latest: FederationLinkStats | null = null;
  for (const link of snapshot.links) {
    if (!link.lastOccurredAt) continue;
    if (!latest || (latest.lastOccurredAt ?? "") < link.lastOccurredAt) {
      latest = link;
    }
  }
  return latest;
}

export function getFederationDenialTotals(
  snapshot: FederationStatsSnapshot | null,
): FederationDenialTotals {
  return snapshot?.denials ?? { policy: 0, auth: 0, notFound: 0 };
}

export function selectLatestFederationLinkFromSnapshots(
  snapshots: Array<FederationStatsSnapshot | null>,
): FederationLinkStats | null {
  let latest: FederationLinkStats | null = null;
  for (const snapshot of snapshots) {
    const candidate = selectLatestFederationLink(snapshot);
    if (!candidate) continue;
    if (!latest || (latest.lastOccurredAt ?? "") < candidate.lastOccurredAt!) {
      latest = candidate;
    }
  }
  return latest;
}

export function sumFederationDenialsAcrossSnapshots(
  snapshots: Array<FederationStatsSnapshot | null>,
): FederationDenialTotals {
  return snapshots.reduce<FederationDenialTotals>((totals, snapshot) => {
    const denials = getFederationDenialTotals(snapshot);
    totals.policy += denials.policy;
    totals.auth += denials.auth;
    totals.notFound += denials.notFound;
    return totals;
  }, { policy: 0, auth: 0, notFound: 0 });
}
