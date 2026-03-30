import { deriveAgentKvName } from "../shared/naming.ts";

export interface DeployCliResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export type RunDeployCli = (
  args: string[],
) => Promise<DeployCliResult>;

export interface EnsureAgentKvDatabaseInput {
  agentId: string;
  appSlug: string;
  deployOrg: string;
  brokerKvDatabase?: string;
  runDeployCli: RunDeployCli;
}

export async function ensureAgentKvDatabase(
  input: EnsureAgentKvDatabaseInput,
): Promise<void> {
  const kvDatabase = deriveAgentKvName(input.agentId);

  const provisionResult = await input.runDeployCli([
    "deploy",
    "database",
    "provision",
    kvDatabase,
    "--kind",
    "denokv",
    "--org",
    input.deployOrg,
  ]);

  const provisionOutput =
    `${provisionResult.stdout}\n${provisionResult.stderr}`;
  if (
    !provisionResult.success &&
    !provisionOutput.includes("The requested slug is already in use.")
  ) {
    throw new Error(
      `failed to provision agent KV ${kvDatabase}: ${provisionOutput.trim()}`
        .trim(),
    );
  }

  if (input.brokerKvDatabase && input.brokerKvDatabase !== kvDatabase) {
    const detachResult = await input.runDeployCli([
      "deploy",
      "database",
      "detach",
      input.brokerKvDatabase,
      "--org",
      input.deployOrg,
      "--app",
      input.appSlug,
    ]);
    const detachOutput = `${detachResult.stdout}\n${detachResult.stderr}`;
    if (
      !detachResult.success &&
      !detachOutput.includes("not assigned") &&
      !detachOutput.includes("not found")
    ) {
      throw new Error(
        `failed to detach broker KV ${input.brokerKvDatabase} from ${input.appSlug}: ${detachOutput.trim()}`
          .trim(),
      );
    }
  }

  const assignResult = await input.runDeployCli([
    "deploy",
    "database",
    "assign",
    kvDatabase,
    "--org",
    input.deployOrg,
    "--app",
    input.appSlug,
  ]);
  const assignOutput = `${assignResult.stdout}\n${assignResult.stderr}`;
  if (
    !assignResult.success &&
    !assignOutput.includes("already has a Deno KV database assigned.")
  ) {
    throw new Error(
      `failed to assign agent KV ${kvDatabase} to ${input.appSlug}: ${assignOutput.trim()}`
        .trim(),
    );
  }
}
