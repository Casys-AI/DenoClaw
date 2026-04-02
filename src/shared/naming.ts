const DENOCLAW_DEPLOY_PREFIX = "denoclaw";

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

export function deriveBrokerAppName(
  projectName = DENOCLAW_DEPLOY_PREFIX,
): string {
  return `${normalizeDeploySlug(projectName)}-broker`;
}

export function deriveBrokerKvName(
  appName = deriveBrokerAppName(),
): string {
  return `${normalizeDeploySlug(appName)}-kv`;
}

export function deriveBrokerPrismaName(
  appName = deriveBrokerAppName(),
): string {
  return `${normalizeDeploySlug(appName)}-db`;
}

export function deriveAgentAppName(
  agentId: string,
  projectName = DENOCLAW_DEPLOY_PREFIX,
): string {
  return `${normalizeDeploySlug(projectName)}-agent-${
    normalizeDeploySlug(agentId)
  }`;
}

export function deriveAgentKvName(
  agentId: string,
  projectName = DENOCLAW_DEPLOY_PREFIX,
): string {
  return `${deriveAgentAppName(agentId, projectName)}-kv`;
}

export function deriveSandboxInstanceName(
  agentId: string,
  projectName = DENOCLAW_DEPLOY_PREFIX,
): string {
  return `${deriveAgentAppName(agentId, projectName)}-sandbox`;
}

export function deriveDeployHostname(slug: string, org?: string): string {
  const normalizedSlug = normalizeDeploySlug(slug);
  return org
    ? `https://${normalizedSlug}.${org}.deno.net`
    : `https://${normalizedSlug}.deno.dev`;
}
