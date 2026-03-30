import type { FederationLinkStats, FederationStatsSnapshot } from "./types.ts";

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
