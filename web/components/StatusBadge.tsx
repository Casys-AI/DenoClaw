/** Tailwind color classes for agent status dots (background). */
export const STATUS_COLORS: Record<string, string> = {
  running: "bg-success",
  alive: "bg-info",
  stopped: "bg-error",
};

/** DaisyUI badge variant classes by status. */
export const STATUS_BADGE_VARIANTS: Record<string, string> = {
  running: "badge-success",
  alive: "badge-info",
  stopped: "badge-error",
  completed: "badge-success",
  failed: "badge-error",
  sent: "badge-info",
  received: "badge-warning",
};

/** DaisyUI badge colorised by agent status. */
export function StatusBadge(
  { status, size = "sm" }: { status: string; size?: "xs" | "sm" | "md" },
) {
  return (
    <span
      class={`badge badge-${size} gap-1 ${
        STATUS_BADGE_VARIANTS[status] ?? "badge-ghost"
      }`}
    >
      {status}
    </span>
  );
}

/** Small dot coloured by status for compact lists. */
export function StatusDot({ status }: { status: string }) {
  return (
    <span
      class={`inline-block w-2 h-2 rounded-full ${
        STATUS_COLORS[status] ?? "bg-neutral"
      }`}
    />
  );
}
