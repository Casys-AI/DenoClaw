/** DaisyUI badge colorise par statut agent. */
export function StatusBadge(
  { status, size = "sm" }: { status: string; size?: "xs" | "sm" | "md" },
) {
  const variant: Record<string, string> = {
    running: "badge-success",
    alive: "badge-info",
    stopped: "badge-error",
    completed: "badge-success",
    failed: "badge-error",
    sent: "badge-info",
    received: "badge-warning",
  };
  return (
    <span
      class={`badge badge-${size} gap-1 ${variant[status] ?? "badge-ghost"}`}
    >
      {status}
    </span>
  );
}

/** Petit dot colore pour les listes compactes. */
export function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    running: "bg-success",
    alive: "bg-info",
    stopped: "bg-error",
  };
  return (
    <span
      class={`inline-block w-2 h-2 rounded-full ${
        color[status] ?? "bg-neutral"
      }`}
    />
  );
}
