# A2A SUBMITTED Lifecycle Cleanup — Design

## Decision

`SUBMITTED` becomes a true neutral entry state for canonical tasks. It is no
longer treated as a bureaucratic pre-state that must pass through `WORKING`
before any meaningful outcome can occur.

## Canonical transition model

The canonical lifecycle will allow these direct transitions from `SUBMITTED`:

- `WORKING`
- `INPUT_REQUIRED`
- `COMPLETED`
- `FAILED`
- `REJECTED`
- `CANCELED`

This reflects reality better:

- a task can complete immediately,
- fail immediately,
- or block immediately on approval/input, without pretending it spent time in
  `WORKING` first.

## Scope

This change is **canonical for all of DenoClaw A2A**, not just local runtime
mapping.

That means:

- `src/messaging/a2a/internal_contract.ts` becomes the source of truth
- `task_mapping.ts` must stop using the temporary normalization helper that
  force-transitions `SUBMITTED -> WORKING`
- tests must be updated to reflect the cleaner contract
- the lifecycle enforcement test remains, but now protects a cleaner contract
  instead of silently blessing a workaround

## Why this is better

If this is only allowed in one subsystem, the architecture rots immediately: the
official contract says one thing while the runtime, mapping helpers, and broker
know another. Making it canonical keeps the model simple and machine-readable.

## Expected implementation

1. Expand `ALLOWED_TASK_STATE_TRANSITIONS.SUBMITTED`
2. Remove the `ensureTaskReadyForLifecycleTransition()` workaround from
   `task_mapping.ts`
3. Keep `transitionTask()` as the only status transition entry point
4. Re-run unit tests and targeted lifecycle guards
