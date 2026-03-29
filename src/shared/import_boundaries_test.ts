import { assertEquals } from "@std/assert";

const SHARED_TYPES_PATH = new URL("./types.ts", import.meta.url);

const FORBIDDEN_DOMAIN_EXPORTS = [
  "ApprovalReason",
  "ApprovalRequest",
  "ApprovalResponse",
  "ExecPolicy",
  "SandboxExecRequest",
  "SandboxBackend",
  "AgentStatusValue",
  "ActiveTaskEntry",
  "AgentStatusEntry",
  "TaskObservationEntry",
] as const;

Deno.test("shared/types exports only shared-kernel contracts", async () => {
  const source = await Deno.readTextFile(SHARED_TYPES_PATH);

  for (const typeName of FORBIDDEN_DOMAIN_EXPORTS) {
    const hasLocalDefinition = source.includes(`export interface ${typeName}`) ||
      source.includes(`export type ${typeName}`);

    assertEquals(
      hasLocalDefinition,
      false,
      `\`${typeName}\` must live in its domain, not be defined in shared/types.ts`,
    );
  }
});
