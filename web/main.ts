import { App, staticFiles } from "@fresh/core";

function normalizeBasePath(basePath?: string): string | undefined {
  if (!basePath || basePath === "/") return undefined;
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

export function createDashboardApp(basePath?: string) {
  const normalizedBasePath = normalizeBasePath(basePath);

  return new App({
    ...(normalizedBasePath ? { basePath: normalizedBasePath } : {}),
  })
    .use(staticFiles())
    .fsRoutes();
}

export const app = createDashboardApp();

/** Export handler for composition with Gateway (no Deno.serve). */
export function createDashboardHandler(
  basePath = Deno.env.get("DENOCLAW_DASHBOARD_BASE_PATH") ?? "/ui",
): (req: Request) => Response | Promise<Response> {
  return createDashboardApp(basePath).handler();
}

if (import.meta.main) {
  await app.listen({ port: 3001 });
}
