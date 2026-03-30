import { parseArgs } from "@std/cli/parse-args";

export interface CliArgs {
  _: (string | number)[];
  message?: string;
  session?: string;
  model?: string;
  agent?: string;
  description?: string;
  "system-prompt"?: string;
  permissions?: string;
  peers?: string;
  "accept-from"?: string;
  org?: string;
  app?: string;
  region?: string;
  force?: boolean;
  json?: boolean;
  yes?: boolean;
  y?: boolean;
  prod?: boolean;
}

function stripTaskForwardSeparator(argv: string[]): string[] {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) return argv;

  return [
    ...argv.slice(0, separatorIndex),
    ...argv.slice(separatorIndex + 1),
  ];
}

export function parseCliArgs(argv: string[]): CliArgs {
  const normalizedArgv = stripTaskForwardSeparator(argv);

  return parseArgs(normalizedArgv, {
    string: [
      "message",
      "session",
      "model",
      "agent",
      "description",
      "system-prompt",
      "permissions",
      "peers",
      "accept-from",
      "org",
      "app",
      "region",
    ],
    boolean: ["force", "json", "yes", "prod"],
    alias: { m: "message", s: "session", a: "agent", y: "yes" },
    default: { session: "default", prod: true },
  }) as CliArgs;
}
