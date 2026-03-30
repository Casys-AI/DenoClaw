import { assertEquals } from "@std/assert";
import { cliFlags, humanWarn, initCliFlags } from "./output.ts";

function captureConsoleLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

Deno.test("initCliFlags enables AX-safe defaults outside a TTY", () => {
  initCliFlags({}, { isTTY: false });
  assertEquals(cliFlags(), {
    json: true,
    yes: true,
    interactive: false,
  });
});

Deno.test("humanWarn stays silent in JSON mode", () => {
  initCliFlags({ json: true }, { isTTY: true });
  const lines = captureConsoleLog(() => {
    humanWarn("deprecated");
  });
  assertEquals(lines, []);
});
