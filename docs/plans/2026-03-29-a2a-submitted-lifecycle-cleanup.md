# A2A SUBMITTED Lifecycle Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Make `SUBMITTED` a clean canonical entry state that can transition
directly to all valid next states without fake normalization through `WORKING`.

**Architecture:** Update the canonical lifecycle contract in
`internal_contract.ts`, then remove the temporary normalization helper from
`task_mapping.ts`, and finally realign tests so they assert the honest lifecycle
instead of a workaround. The contract remains centralized in `transitionTask()`
and enforced by targeted tests.

**Tech Stack:** Deno, TypeScript, Deno test, canonical A2A lifecycle helpers in
`src/messaging/a2a/*`

---

### Task 1: Update the canonical transition matrix

**Files:**

- Modify: `src/messaging/a2a/internal_contract.ts`
- Test: `src/messaging/a2a/internal_contract_test.ts`

**Step 1: Write/adjust failing lifecycle expectations**

Add assertions that `SUBMITTED` can transition directly to `INPUT_REQUIRED` and
`COMPLETED`.

**Step 2: Run targeted test to verify failure if needed**

Run:

```bash
deno test src/messaging/a2a/internal_contract_test.ts
```

**Step 3: Update `ALLOWED_TASK_STATE_TRANSITIONS.SUBMITTED`**

Allow direct transitions to:

- `WORKING`
- `INPUT_REQUIRED`
- `COMPLETED`
- `FAILED`
- `REJECTED`
- `CANCELED`

**Step 4: Re-run targeted test**

Run:

```bash
deno test src/messaging/a2a/internal_contract_test.ts
```

**Step 5: Commit**

```bash
git add src/messaging/a2a/internal_contract.ts src/messaging/a2a/internal_contract_test.ts
git commit -m "refactor(a2a): allow direct submitted lifecycle transitions"
```

---

### Task 2: Remove the normalization workaround from task mapping

**Files:**

- Modify: `src/messaging/a2a/task_mapping.ts`
- Test: `src/messaging/a2a/task_mapping_test.ts`
- Test: `src/messaging/a2a/internal_contract_enforcement_test.ts`

**Step 1: Write/adjust failing tests if needed**

Ensure the tests describe direct `SUBMITTED -> COMPLETED` and
`SUBMITTED -> INPUT_REQUIRED` behavior through canonical helpers.

**Step 2: Remove the helper that force-transitions `SUBMITTED -> WORKING`**

Delete the normalization helper and call `transitionTask()` directly from the
original task state.

**Step 3: Keep all lifecycle writes centralized**

Do not reintroduce raw `status: { state: ... }` object construction.

**Step 4: Re-run targeted tests**

Run:

```bash
deno test --allow-read src/messaging/a2a/task_mapping_test.ts src/messaging/a2a/internal_contract_enforcement_test.ts
```

**Step 5: Commit**

```bash
git add src/messaging/a2a/task_mapping.ts src/messaging/a2a/task_mapping_test.ts src/messaging/a2a/internal_contract_enforcement_test.ts
git commit -m "refactor(a2a): remove submitted-to-working normalization"
```

---

### Task 3: Run the full suite and merge cleanup

**Files:**

- No new files required

**Step 1: Run the full unit suite**

Run:

```bash
deno task test:unit
```

Expected: PASS.

**Step 2: Commit any remaining test/doc alignment**

```bash
git add -A
git commit -m "test(a2a): align lifecycle tests with canonical submitted transitions"
```

Only if there are remaining staged changes.

**Step 3: Open PR or merge directly if working on a short-lived cleanup branch**

Use the existing branch created for this cleanup.
