import { assertEquals, assertRejects } from "@std/assert";
import { ask, confirm } from "./prompt.ts";
import { CliError, initCliFlags } from "./output.ts";

Deno.test("confirm auto-approves when --yes is enabled", async () => {
  initCliFlags({ yes: true }, { isTTY: true });
  assertEquals(await confirm("Delete agent?", false), true);
});

Deno.test("ask throws a structured CLI error in non-interactive mode", async () => {
  initCliFlags({}, { isTTY: false });
  await assertRejects(
    () => ask("API key"),
    CliError,
    'Cannot prompt for "API key" in non-interactive mode',
  );
});
