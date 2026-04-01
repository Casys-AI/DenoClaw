import { assertEquals, assertRejects } from "@std/assert";
import { ask, confirm, print, success } from "./prompt.ts";
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

Deno.test("prompt human output stays silent in JSON mode", () => {
  initCliFlags({ json: true }, { isTTY: true });

  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    print("hello");
    success("done");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assertEquals(lines, []);
  assertEquals(errors, []);
});
