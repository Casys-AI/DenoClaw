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

export function getMaxSandboxesPerBroker(): number {
  const raw = Deno.env.get("MAX_SANDBOXES_PER_BROKER") ??
    Deno.env.get("DENOCLAW_MAX_SANDBOXES_PER_BROKER");
  if (!raw) return 5;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 5;
  return parsed;
}
