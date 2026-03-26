import { assertEquals } from "@std/assert";
import { WebFetchTool } from "./web.ts";

const web = new WebFetchTool();

Deno.test("WebFetchTool fails on missing URL", async () => {
  const result = await web.execute({});
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "MISSING_ARG");
});

Deno.test("WebFetchTool fails on invalid URL", async () => {
  const result = await web.execute({ url: "not-a-url" });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "INVALID_URL");
});

Deno.test("WebFetchTool getDefinition has correct schema", () => {
  const def = web.getDefinition();
  assertEquals(def.function.name, "web_fetch");
  assertEquals(def.function.parameters.required, ["url"]);
});
