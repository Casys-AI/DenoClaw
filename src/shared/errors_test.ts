import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  ChannelError,
  ConfigError,
  DenoClawError,
  ProviderError,
  ToolError,
} from "./errors.ts";

Deno.test("error hierarchy with structured fields", () => {
  const config = new ConfigError(
    "CONFIG_NOT_FOUND",
    { path: "/tmp" },
    "Run onboard",
  );
  assertInstanceOf(config, DenoClawError);
  assertInstanceOf(config, Error);
  assertEquals(config.name, "ConfigError");
  assertEquals(config.code, "CONFIG_NOT_FOUND");
  assertEquals(config.context?.path, "/tmp");
  assertEquals(config.recovery, "Run onboard");
});

Deno.test("toStructured returns AX-compliant object", () => {
  const err = new ProviderError(
    "NO_PROVIDER",
    { model: "test" },
    "Add API key",
  );
  const s = err.toStructured();
  assertEquals(s.code, "NO_PROVIDER");
  assertEquals(s.context?.model, "test");
  assertEquals(s.recovery, "Add API key");
});

Deno.test("all error types have correct names", () => {
  assertEquals(new ProviderError("X").name, "ProviderError");
  assertEquals(new ToolError("X").name, "ToolError");
  assertEquals(new ChannelError("X").name, "ChannelError");
  assertEquals(new ConfigError("X").name, "ConfigError");
});
