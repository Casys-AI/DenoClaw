# A2A contract

This directory defines the canonical A2A task contract used by public transports
and local runtime adapters.

## Stable public surface

Import public A2A types and ports from `src/messaging/a2a/mod.ts`.

- protocol types: `Task`, `TaskStatus`, `TaskState`, events, messages, agent
  card types
- runtime port: `A2ARuntimePort`, `SubmitTaskRequest`, `ContinueTaskRequest`,
  `RuntimeTaskEvent`
- transport entrypoints: `A2AClient`, `A2AServer`

## Internal contract

`internal_contract.ts` is the single source of truth for canonical task
invariants:

- context-id resolution
- allowed state transitions
- task creation and task-state transitions
- terminal-state checks and refusal classification

`task_mapping.ts` maps runtime inputs (text, errors, approval pauses) into
canonical tasks but does not redefine lifecycle rules.

## Input-required metadata

`INPUT_REQUIRED` details live under `status.metadata.awaitedInput`, using
helpers from `input_metadata.ts`.

When a task resumes, the runtime should emit a fresh `WORKING` status instead of
carrying forward stale awaited-input metadata.

## Naming compatibility

During the migration, transport-facing payloads may still expose `message` as a
legacy alias. New code should prefer `taskMessage`, `continuationMessage`,
`initialMessage`, and `statusMessage` depending on the lifecycle stage.
