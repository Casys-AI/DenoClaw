/** Redirect / → /overview */
import type { FreshContext } from "@fresh/core";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";

export const handler = {
  GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const config = getDashboardRequestConfig(ctx.req);
    return Response.redirect(new URL(config.overviewPath, ctx.url.origin), 307);
  },
};

export default function Index() {
  return null;
}
