import { assertEquals } from "@std/assert";
import { getMaxSandboxesPerBroker } from "./deploy_credentials.ts";

Deno.test("getMaxSandboxesPerBroker defaults to 5", () => {
  const previousMax = Deno.env.get("MAX_SANDBOXES_PER_BROKER");
  const previousScoped = Deno.env.get("DENOCLAW_MAX_SANDBOXES_PER_BROKER");

  try {
    Deno.env.delete("MAX_SANDBOXES_PER_BROKER");
    Deno.env.delete("DENOCLAW_MAX_SANDBOXES_PER_BROKER");
    assertEquals(getMaxSandboxesPerBroker(), 5);
  } finally {
    if (previousMax !== undefined) {
      Deno.env.set("MAX_SANDBOXES_PER_BROKER", previousMax);
    } else {
      Deno.env.delete("MAX_SANDBOXES_PER_BROKER");
    }
    if (previousScoped !== undefined) {
      Deno.env.set("DENOCLAW_MAX_SANDBOXES_PER_BROKER", previousScoped);
    } else {
      Deno.env.delete("DENOCLAW_MAX_SANDBOXES_PER_BROKER");
    }
  }
});

Deno.test("getMaxSandboxesPerBroker prefers MAX_SANDBOXES_PER_BROKER", () => {
  const previousMax = Deno.env.get("MAX_SANDBOXES_PER_BROKER");
  const previousScoped = Deno.env.get("DENOCLAW_MAX_SANDBOXES_PER_BROKER");

  try {
    Deno.env.set("MAX_SANDBOXES_PER_BROKER", "3");
    Deno.env.set("DENOCLAW_MAX_SANDBOXES_PER_BROKER", "9");
    assertEquals(getMaxSandboxesPerBroker(), 3);
  } finally {
    if (previousMax !== undefined) {
      Deno.env.set("MAX_SANDBOXES_PER_BROKER", previousMax);
    } else {
      Deno.env.delete("MAX_SANDBOXES_PER_BROKER");
    }
    if (previousScoped !== undefined) {
      Deno.env.set("DENOCLAW_MAX_SANDBOXES_PER_BROKER", previousScoped);
    } else {
      Deno.env.delete("DENOCLAW_MAX_SANDBOXES_PER_BROKER");
    }
  }
});

Deno.test("getMaxSandboxesPerBroker falls back to default on invalid values", () => {
  const previousMax = Deno.env.get("MAX_SANDBOXES_PER_BROKER");

  try {
    Deno.env.set("MAX_SANDBOXES_PER_BROKER", "0");
    assertEquals(getMaxSandboxesPerBroker(), 5);
    Deno.env.set("MAX_SANDBOXES_PER_BROKER", "nope");
    assertEquals(getMaxSandboxesPerBroker(), 5);
  } finally {
    if (previousMax !== undefined) {
      Deno.env.set("MAX_SANDBOXES_PER_BROKER", previousMax);
    } else {
      Deno.env.delete("MAX_SANDBOXES_PER_BROKER");
    }
  }
});
