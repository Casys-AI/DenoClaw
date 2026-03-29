import type { ComponentChildren } from "preact";

/** Standard wrapper for page content. */
export function PageLayout(
  { title, children }: { title: string; children: ComponentChildren },
) {
  return (
    <div class="space-y-6">
      <h1 class="text-2xl font-display font-bold">{title}</h1>
      {children}
    </div>
  );
}
