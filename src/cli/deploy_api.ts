import { fromFileUrl, join } from "@std/path";
import type { Config } from "../config/types.ts";
import type { AgentEntry } from "../shared/types.ts";
import { deriveAgentAppName, deriveDeployHostname } from "../shared/naming.ts";
import { humanLog } from "./output.ts";

export const DEPLOY_API_V2 = "https://api.deno.com/v2";
const AGENT_ID_LABEL = "custom.denoclaw.agent_id";

type DeployAsset = {
  kind: "file";
  content: string;
  encoding: "utf-8";
};

export interface DeployAppRef {
  id: string;
  slug: string;
}

export interface DeployRevisionRef {
  id: string;
}

export function resolveBrokerUrl(config: Config): string | undefined {
  return Deno.env.get("DENOCLAW_BROKER_URL") ??
    config.deploy?.url ??
    (config.deploy?.app
      ? deriveDeployHostname(config.deploy.app, config.deploy.org)
      : undefined);
}

export async function registerAgentEndpointWithBroker(input: {
  brokerUrl: string;
  authToken: string;
  agentId: string;
  endpoint: string;
  config: AgentEntry;
}): Promise<void> {
  const res = await fetch(new URL("/agents/register", input.brokerUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${input.authToken}`,
    },
    body: JSON.stringify({
      agentId: input.agentId,
      endpoint: input.endpoint,
      config: input.config,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Broker registration failed (${res.status}) ${body}`.trim(),
    );
  }
}

export async function buildDeployAssets(
  entrypoint: string,
): Promise<Record<string, DeployAsset>> {
  const assets: Record<string, DeployAsset> = {
    "main.ts": {
      kind: "file",
      content: entrypoint,
      encoding: "utf-8",
    },
    "deno.json": {
      kind: "file",
      content: await Deno.readTextFile(
        new URL("../../deno.json", import.meta.url),
      ),
      encoding: "utf-8",
    },
  };

  const srcDir = fromFileUrl(new URL("../", import.meta.url));
  await addDirectoryAssets(srcDir, "src", assets);
  return assets;
}

async function addDirectoryAssets(
  dirPath: string,
  assetDir: string,
  assets: Record<string, DeployAsset>,
): Promise<void> {
  for await (const entry of Deno.readDir(dirPath)) {
    const absolutePath = join(dirPath, entry.name);
    const assetPath = `${assetDir}/${entry.name}`;

    if (entry.isDirectory) {
      await addDirectoryAssets(absolutePath, assetPath, assets);
      continue;
    }

    if (!entry.isFile || !shouldIncludeSourceAsset(entry.name)) continue;

    assets[assetPath] = {
      kind: "file",
      content: await Deno.readTextFile(absolutePath),
      encoding: "utf-8",
    };
  }
}

function shouldIncludeSourceAsset(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith("_test.ts");
}

export function deriveDeployAppSlug(agentId: string): string {
  return deriveAgentAppName(agentId);
}

export function createDeployApiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function createDeployEnvVars(
  input: Record<string, string | undefined>,
): Array<{ key: string; value: string }> {
  return Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => ({ key, value }));
}

export function getDeployAppEndpoint(app: DeployAppRef, org?: string): string {
  return deriveDeployHostname(app.slug, org);
}

export async function updateDeployAppConfig(input: {
  app: string;
  headers: Record<string, string>;
  config: {
    install?: string | null;
    build?: string | null;
    predeploy?: string | null;
    runtime: {
      type: "dynamic" | "static";
      entrypoint?: string;
      args?: string[];
      cwd?: string;
      spa?: boolean;
    };
    crons?: boolean;
  };
}): Promise<void> {
  const res = await fetch(`${DEPLOY_API_V2}/apps/${input.app}`, {
    method: "PATCH",
    headers: input.headers,
    body: JSON.stringify({
      config: input.config,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `failed to update deploy app "${input.app}" (${res.status}) ${body}`
        .trim(),
    );
  }
}

export async function ensureDeployApp(
  agentId: string,
  headers: Record<string, string>,
): Promise<DeployAppRef> {
  const slug = deriveDeployAppSlug(agentId);
  const existingRes = await fetch(`${DEPLOY_API_V2}/apps/${slug}`, { headers });

  if (existingRes.ok) {
    const existing = await existingRes.json() as {
      id: string;
      slug: string;
      labels?: Record<string, string>;
    };
    const existingAgentId = existing.labels?.[AGENT_ID_LABEL];
    if (existingAgentId && existingAgentId !== agentId) {
      throw new Error(
        `deploy app slug "${slug}" is already assigned to agent "${existingAgentId}"`,
      );
    }
    printDeployAppReuse(existing.slug);
    return { id: existing.id, slug: existing.slug };
  }

  if (existingRes.status !== 404) {
    const body = await existingRes.text().catch(() => "");
    throw new Error(
      `failed to inspect deploy app "${slug}" (${existingRes.status}) ${body}`
        .trim(),
    );
  }

  const createRes = await fetch(`${DEPLOY_API_V2}/apps`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      slug,
      labels: {
        [AGENT_ID_LABEL]: agentId,
      },
      config: {
        runtime: {
          type: "dynamic",
          entrypoint: "main.ts",
        },
      },
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(
      `failed to create deploy app "${slug}" (${createRes.status}) ${body}`
        .trim(),
    );
  }

  const created = await createRes.json() as { id: string; slug: string };
  return { id: created.id, slug: created.slug };
}

export async function deployAppRevision(input: {
  app: DeployAppRef;
  assets: Record<string, DeployAsset>;
  envVars: Array<{ key: string; value: string }>;
  headers: Record<string, string>;
}): Promise<DeployRevisionRef> {
  const deployRes = await fetch(
    `${DEPLOY_API_V2}/apps/${input.app.slug}/deploy`,
    {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({
        assets: input.assets,
        config: {
          runtime: {
            type: "dynamic",
            entrypoint: "main.ts",
          },
        },
        env_vars: input.envVars,
        production: true,
      }),
    },
  );

  if (!deployRes.ok) {
    const body = await deployRes.text().catch(() => "");
    throw new Error(
      `deployment failed for app "${input.app.slug}" (${deployRes.status}) ${body}`
        .trim(),
    );
  }

  const revision = await deployRes.json() as { id: string };
  return { id: revision.id };
}

function printDeployAppReuse(slug: string): void {
  humanLog(`  Deploy app already exists, reusing slug "${slug}".`);
}
