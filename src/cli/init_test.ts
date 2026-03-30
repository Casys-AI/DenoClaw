import { assertEquals, assertRejects } from "@std/assert";
import { runInitWizard } from "./init.ts";
import { CliError, initCliFlags } from "./output.ts";

function captureConsoleLogAsync(fn: () => Promise<void>): {
  lines: string[];
  done: Promise<void>;
} {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const done = fn().finally(() => {
    console.log = original;
  });
  return { lines, done };
}

Deno.test("runInitWizard fails cleanly before printing banners in non-interactive mode", async () => {
  initCliFlags({ json: true }, { isTTY: false });
  const captured = captureConsoleLogAsync(() => runInitWizard());
  await assertRejects(
    () => captured.done,
    CliError,
    "denoclaw init requires an interactive terminal",
  );
  assertEquals(captured.lines, []);
});
