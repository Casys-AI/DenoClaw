import { App, staticFiles } from "@fresh/core";

export const app = new App()
  .use(staticFiles())
  .fsRoutes();

/** Export handler for composition with Gateway (no Deno.serve). */
export function createDashboardHandler(): (
  req: Request,
) => Response | Promise<Response> {
  return app.handler();
}
