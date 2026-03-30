#!/usr/bin/env -S deno run --unstable-kv --unstable-cron --allow-all --env

import { runCli } from "./src/cli/entry.ts";
import { CliError, outputError } from "./src/cli/output.ts";
import { log } from "./src/shared/log.ts";

try {
  await runCli(Deno.args);
} catch (e) {
  if (e instanceof CliError) {
    outputError(e.code, e.message);
    Deno.exit(1);
  }
  log.error("Fatal error", e);
  Deno.exit(1);
}
