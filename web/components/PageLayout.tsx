import type { ComponentChildren } from "preact";

/** Wrapper standard pour le contenu des pages. */
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
