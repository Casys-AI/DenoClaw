export function getDeployOrgToken(): string | undefined {
  return Deno.env.get("DENO_DEPLOY_ORG_TOKEN") ??
    Deno.env.get("DENO_DEPLOY_TOKEN");
}

export function getSandboxAccessToken(): string | undefined {
  return Deno.env.get("DENOCLAW_SANDBOX_API_TOKEN") ??
    Deno.env.get("DENO_DEPLOY_ORG_TOKEN") ??
    Deno.env.get("DENO_SANDBOX_API_TOKEN") ??
    Deno.env.get("DENO_DEPLOY_TOKEN");
}
