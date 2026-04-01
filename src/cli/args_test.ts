import { assertEquals } from "@std/assert";
import { parseCliArgs } from "./args.ts";

Deno.test("parseCliArgs treats deno task forwarded --yes as a flag", () => {
  const args = parseCliArgs(["publish", "--", "--yes"]);

  assertEquals(args._, ["publish"]);
  assertEquals(args.yes, true);
});

Deno.test("parseCliArgs preserves positional args forwarded through deno task", () => {
  const args = parseCliArgs(["publish", "--", "alice"]);

  assertEquals(args._, ["publish", "alice"]);
  assertEquals(args.yes, false);
});

Deno.test("parseCliArgs strips only the deno task separator", () => {
  const args = parseCliArgs(["publish", "--", "--", "--yes"]);

  assertEquals(args._, ["publish", "--yes"]);
  assertEquals(args.yes, false);
});

Deno.test("parseCliArgs supports --force for publish", () => {
  const args = parseCliArgs(["publish", "alice", "--force"]);

  assertEquals(args._, ["publish", "alice"]);
  assertEquals(args.force, true);
});
