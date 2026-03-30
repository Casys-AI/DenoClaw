import { assertRejects } from "@std/assert";
import { ensureAgentKvDatabase } from "./publish_kv.ts";

Deno.test("ensureAgentKvDatabase tolerates existing KV and assignment", async () => {
  const calls: string[][] = [];

  await ensureAgentKvDatabase({
    agentId: "alice",
    appSlug: "denoclaw-agent-alice",
    deployOrg: "casys",
    brokerKvDatabase: "denoclaw-broker-kv",
    runDeployCli: (args) => {
      calls.push(args);
      if (args[2] === "provision") {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "The requested slug is already in use.",
        });
      }
      if (args[2] === "detach") {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "not assigned",
        });
      }
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "The app already has a Deno KV database assigned.",
      });
    },
  });

  if (calls.length !== 3) {
    throw new Error(`expected 3 deploy CLI calls, got ${calls.length}`);
  }
});

Deno.test("ensureAgentKvDatabase fails on unexpected detach errors", async () => {
  await assertRejects(
    () =>
      ensureAgentKvDatabase({
        agentId: "alice",
        appSlug: "denoclaw-agent-alice",
        deployOrg: "casys",
        brokerKvDatabase: "denoclaw-broker-kv",
        runDeployCli: (args) => {
          if (args[2] === "provision") {
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          }
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "permission denied",
          });
        },
      }),
    Error,
    "failed to detach broker KV denoclaw-broker-kv",
  );
});
