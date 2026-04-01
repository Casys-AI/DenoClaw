/** Format a number with compact notation (1.2k, 3.4M). */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

/** Format USD cost. */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format milliseconds as human-readable latency. */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format ISO date as relative time. */
export function formatRelative(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "—";

  const diffMs = timestamp - Date.now();
  const future = diffMs > 0;
  const secs = Math.floor(Math.abs(diffMs) / 1000);

  if (secs < 60) return future ? `in ${secs}s` : `${secs}s ago`;

  const mins = Math.floor(secs / 60);
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}
