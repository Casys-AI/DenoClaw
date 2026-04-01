import { Sandbox } from "@deno/sandbox";
import { DEFAULT_PASSTHROUGH_ENV_KEYS } from "../src/agent/tools/shell.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function logShell(
  label: string,
  fn: () => PromiseLike<{
    status?: {
      code?: number;
    };
    stdoutText?: string | null;
    stderrText?: string | null;
  }>,
): Promise<void> {
  try {
    const result = await fn();
    console.log(`\n[SHELL] ${label}`);
    console.log(`exit=${result.status?.code}`);
    if (result.stdoutText) console.log(`stdout:\n${result.stdoutText}`);
    if (result.stderrText) console.log(`stderr:\n${result.stderrText}`);
  } catch (error) {
    console.log(`\n[SHELL] ${label}`);
    console.log(
      `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function logStep(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await fn();
    console.log(`\n[STEP] ${label}`);
    if (result !== undefined) console.log(result);
  } catch (error) {
    console.log(`\n[STEP] ${label}`);
    console.log(
      `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function logSpawn(
  label: string,
  fn: () => Promise<{
    status: { code?: number };
    stdoutText?: string | null;
    stderrText?: string | null;
  }>,
): Promise<void> {
  const result = await fn();
  console.log(`\n[SPAWN] ${label}`);
  console.log(`exit=${result.status.code}`);
  if (result.stdoutText) console.log(`stdout:\n${result.stdoutText}`);
  if (result.stderrText) console.log(`stderr:\n${result.stderrText}`);
}

const token = Deno.env.get("DENOCLAW_SANDBOX_API_TOKEN") ??
  requireEnv("DENO_DEPLOY_ORG_TOKEN");

const agentRoot = new URL("../src/agent/", import.meta.url).pathname;
const sharedRoot = new URL("../src/shared/", import.meta.url).pathname;
const denoJsonPath = new URL(
  "../src/agent/tools/backends/sandbox_deno.json",
  import.meta.url,
).pathname;

await using sandbox = await Sandbox.create({
  token,
  timeout: "5m",
});

console.log("Sandbox created");

await logShell("pwd", () => sandbox.sh`pwd`.stdout("piped").stderr("piped"));
await logShell(
  "ls -la",
  () => sandbox.sh`ls -la`.stdout("piped").stderr("piped"),
);
await logShell(
  "ls -la /",
  () => sandbox.sh`ls -la /`.stdout("piped").stderr("piped"),
);

await logStep(
  "fs.mkdir('app', recursive)",
  () => sandbox.fs.mkdir("app", { recursive: true }),
);
await logStep(
  "fs.mkdir('./app/tools', recursive)",
  () => sandbox.fs.mkdir("./app/tools", { recursive: true }),
);
await logStep(
  "fs.mkdir('/app', recursive)",
  () => sandbox.fs.mkdir("/app", { recursive: true }),
);
await logStep(
  "fs.mkdir('/app/tools', recursive)",
  () => sandbox.fs.mkdir("/app/tools", { recursive: true }),
);

await logStep(
  "fs.mkdir('src', recursive)",
  () => sandbox.fs.mkdir("src", { recursive: true }),
);
await logStep(
  "fs.upload(denoJsonPath, './deno.json')",
  () => sandbox.fs.upload(denoJsonPath, "./deno.json"),
);
await logStep(
  "fs.upload(agentRoot, './src')",
  () => sandbox.fs.upload(agentRoot, "./src"),
);
await logStep(
  "fs.upload(sharedRoot, './src')",
  () => sandbox.fs.upload(sharedRoot, "./src"),
);
await logStep(
  "fs.upload(sharedRoot, '/app')",
  () => sandbox.fs.upload(sharedRoot, "/app"),
);

const executorInput = JSON.stringify({
  tool: "shell",
  args: { command: "deno --version", dry_run: false },
});

await logSpawn("deno run src/agent/tools/tool_executor.ts", async () => {
  const child = await sandbox.spawn("deno", {
    args: [
      "run",
      "--allow-run",
      `--allow-env=${DEFAULT_PASSTHROUGH_ENV_KEYS.join(",")}`,
      "src/agent/tools/tool_executor.ts",
      executorInput,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  return await child.output();
});
