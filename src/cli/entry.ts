import { getConfig, getConfigOrDefault } from "../config/loader.ts";
import { createAgent, deleteAgent, listAgents } from "./agents.ts";
import { parseCliArgs } from "./args.ts";
import { printHelp } from "./help.ts";
import { humanLog, humanWarn, initCliFlags, outputError } from "./output.ts";
import { runInitWizard } from "./init.ts";
import {
  deployBroker,
  publishAgent,
  setupAgent,
  setupChannel,
  setupProvider,
  showStatus,
} from "./setup.ts";
import { startAgentRuntime } from "../runtime/start_agent.ts";
import { startLocalGateway } from "../runtime/start_local.ts";
import { startBrokerRuntime } from "../runtime/start_broker.ts";
import { startLocalTunnel } from "../runtime/start_tunnel.ts";
import type { Config } from "../config/types.ts";

export interface CliCommandDeps {
  getConfig: typeof getConfig;
  getConfigOrDefault: typeof getConfigOrDefault;
  createAgent: typeof createAgent;
  deleteAgent: typeof deleteAgent;
  listAgents: typeof listAgents;
  printHelp: typeof printHelp;
  initCliFlags: typeof initCliFlags;
  runInitWizard: typeof runInitWizard;
  setupProvider: typeof setupProvider;
  setupChannel: typeof setupChannel;
  setupAgent: typeof setupAgent;
  deployBroker: typeof deployBroker;
  publishAgent: typeof publishAgent;
  showStatus: typeof showStatus;
  startAgentRuntime: typeof startAgentRuntime;
  startLocalGateway: typeof startLocalGateway;
  startBrokerRuntime: typeof startBrokerRuntime;
  startLocalTunnel: typeof startLocalTunnel;
  humanLog(message: string): void;
  humanWarn(message: string): void;
  outputError(code: string, message: string): void;
  streamBrokerLogs(config: Config): Promise<void>;
}

function createCliCommandDeps(): CliCommandDeps {
  return {
    getConfig,
    getConfigOrDefault,
    createAgent,
    deleteAgent,
    listAgents,
    printHelp,
    initCliFlags,
    runInitWizard,
    setupProvider,
    setupChannel,
    setupAgent,
    deployBroker,
    publishAgent,
    showStatus,
    startAgentRuntime,
    startLocalGateway,
    startBrokerRuntime,
    startLocalTunnel,
    humanLog,
    humanWarn,
    outputError,
    streamBrokerLogs: async (config) => {
      const deploy = config.deploy;
      if (!deploy?.org || !deploy?.app) {
        outputError(
          "BROKER_NOT_DEPLOYED",
          "No broker deployed. Run 'denoclaw deploy' first.",
        );
        return;
      }
      const logsCmd = new Deno.Command("deno", {
        args: ["deploy", "logs", "--org", deploy.org, "--app", deploy.app],
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      const { success: ok } = await logsCmd.output();
      if (!ok) outputError("LOG_STREAM_FAILED", "Failed to stream logs.");
    },
  };
}

export async function runCli(
  argv: string[],
  deps: CliCommandDeps = createCliCommandDeps(),
): Promise<void> {
  const args = parseCliArgs(argv);
  deps.initCliFlags({ json: !!args.json, yes: !!args.yes });

  const command = args._[0] as string | undefined;
  const subcommand = args._[1] as string | undefined;

  switch (command) {
    case "setup":
      deps.humanWarn(
        "⚠ 'denoclaw setup' is deprecated. Use 'denoclaw init' instead.\n",
      );
      switch (subcommand) {
        case "provider":
          await deps.setupProvider();
          break;
        case "channel":
          await deps.setupChannel();
          break;
        case "agent":
          await deps.setupAgent();
          break;
        default:
          deps.humanLog("Usage: denoclaw setup [provider|channel|agent]");
          break;
      }
      return;

    case "deploy": {
      const subCmd = args._[1] as string | undefined;
      if (subCmd === "agent") {
        deps.humanWarn(
          "⚠ 'denoclaw deploy agent' is deprecated. Use 'denoclaw publish <agent>' instead.\n",
        );
        await deps.publishAgent();
      } else {
        await deps.deployBroker({
          org: args.org,
          app: args.app,
          region: args.region,
          prod: args.prod,
        });
      }
      return;
    }

    case "publish": {
      const { publishAgents } = await import("./publish.ts");
      const target = args._[1] as string | undefined;
      await publishAgents(target);
      return;
    }

    case "init":
      await deps.runInitWizard();
      return;

    case "agent": {
      if (subcommand === "list") {
        await deps.listAgents();
        return;
      }
      if (subcommand === "create") {
        await deps.createAgent(args._[2] as string, {
          description: args.description,
          model: args.model,
          systemPrompt: args["system-prompt"],
          permissions: args.permissions,
          peers: args.peers,
          acceptFrom: args["accept-from"],
          force: !!args.force,
        });
        return;
      }
      if (subcommand === "delete") {
        await deps.deleteAgent(args._[2] as string, {
          yes: !!args.yes || !!args.y,
        });
        return;
      }

      const config = await deps.getConfigOrDefault();
      const hasProvider = Object.values(config.providers).some((provider) =>
        provider?.apiKey || provider?.enabled
      );
      if (!hasProvider) {
        deps.humanLog("No provider configured. Starting initial setup.\n");
        await deps.runInitWizard();
        return;
      }
      await deps.startAgentRuntime(config, args);
      return;
    }

    case "dev": {
      const config = await deps.getConfig();
      if (args.agent) {
        await deps.startAgentRuntime(config, args);
      } else {
        await deps.startLocalGateway(config);
      }
      return;
    }

    case undefined:
      if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
        const config = await deps.getConfigOrDefault();
        await deps.startBrokerRuntime(config);
      } else {
        deps.printHelp();
      }
      return;

    case "gateway": {
      deps.humanWarn(
        "⚠ 'denoclaw gateway' is deprecated. Use 'denoclaw dev' instead.\n",
      );
      const config = await deps.getConfig();
      await deps.startLocalGateway(config);
      return;
    }

    case "broker": {
      deps.humanWarn(
        "⚠ 'denoclaw broker' is deprecated. Use 'denoclaw deploy' for production.\n",
      );
      const config = await deps.getConfigOrDefault();
      const port = parseInt(String(args._[1] ?? "")) || 3000;
      await deps.startBrokerRuntime(config, port);
      return;
    }

    case "tunnel":
      await deps.startLocalTunnel(args._[1] as string | undefined);
      return;

    case "status": {
      const config = await deps.getConfigOrDefault();
      await deps.showStatus(config);
      return;
    }

    case "logs": {
      const config = await deps.getConfigOrDefault();
      await deps.streamBrokerLogs(config);
      return;
    }

    case "help":
    default:
      deps.printHelp();
      return;
  }
}
