#!/usr/bin/env -S deno run --unstable-kv --allow-all --env

import { Builder } from "@fresh/core/dev";
import * as path from "@std/path";

const webDir = path.dirname(path.fromFileUrl(import.meta.url));

const builder = new Builder({
  root: webDir,
  routeDir: path.join(webDir, "routes"),
  islandDir: path.join(webDir, "islands"),
  staticDir: path.join(webDir, "static"),
});

if (Deno.args.includes("build")) {
  await builder.build(async () => (await import("./mod.ts")).app);
} else {
  await builder.listen(async () => (await import("./mod.ts")).app, {
    port: 3001,
  });
}
