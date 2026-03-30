export function normalizeDeploySlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");

  if (!slug) {
    throw new Error(`Cannot derive deploy slug from "${value}"`);
  }

  return slug;
}

export function deriveBrokerKvName(appName: string): string {
  return `${normalizeDeploySlug(appName)}-kv`;
}

export function deriveAgentAppName(agentId: string): string {
  return normalizeDeploySlug(agentId);
}

export function deriveAgentKvName(agentId: string): string {
  return `${deriveAgentAppName(agentId)}-kv`;
}

export function deriveSandboxInstanceName(agentId: string): string {
  return `${deriveAgentAppName(agentId)}-sandbox`;
}

export function deriveDeployHostname(slug: string, org?: string): string {
  const normalizedSlug = normalizeDeploySlug(slug);
  return org
    ? `https://${normalizedSlug}.${org}.deno.net`
    : `https://${normalizedSlug}.deno.dev`;
}
