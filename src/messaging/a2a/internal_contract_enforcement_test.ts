import { assertEquals, assertMatch } from "@std/assert";

interface GuardedFileRule {
  path: string;
  requiredPatterns: RegExp[];
  forbiddenPatterns: RegExp[];
}

const GUARDED_FILES: GuardedFileRule[] = [
  {
    path: "src/agent/runtime.ts",
    requiredPatterns: [/createCanonicalTask\(/, /transitionTask\(/],
    forbiddenPatterns: [
      /status\s*:\s*{\s*state\s*:/m,
    ],
  },
  {
    path: "src/messaging/a2a/tasks.ts",
    requiredPatterns: [/createCanonicalTask\(/, /transitionTask\(/],
    forbiddenPatterns: [
      /status\s*:\s*{\s*state\s*:/m,
    ],
  },
  {
    path: "src/messaging/a2a/task_mapping.ts",
    requiredPatterns: [/transitionTask\(/],
    forbiddenPatterns: [
      /status\s*:\s*{\s*state\s*:/m,
    ],
  },
];

Deno.test("canonical lifecycle transitions are centralized in internal_contract", async () => {
  for (const rule of GUARDED_FILES) {
    const source = await Deno.readTextFile(rule.path);

    for (const pattern of rule.requiredPatterns) {
      assertMatch(source, pattern);
    }

    for (const pattern of rule.forbiddenPatterns) {
      assertEquals(
        pattern.test(source),
        false,
        `${rule.path} should not define raw state transitions; use internal_contract.ts`,
      );
    }
  }
});
