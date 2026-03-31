# Privilege Elevation Migration Plan

**Date:** 2026-03-31 **Status:** In Progress

## Goal

Replace the current command-approval flow with a broker-governed temporary
privilege elevation flow.

Target model:

- if execution is allowed by policy, it runs
- if execution is blocked by exec policy, return `EXEC_POLICY_DENIED`
- if execution is blocked by missing sandbox privileges, return
  `PRIVILEGE_ELEVATION_REQUIRED`
- human/operator intervention, when needed, applies to temporary privilege
  grants
- human/operator intervention does **not** approve command strings directly

## Findings

- broker/runtime now distinguish privilege-elevation support from actual
  availability, and `no_channel` is handled as a structured non-resumable case
- the core privilege-elevation flow is functionally in place; the remaining work
  is cleanup and tightening, not redesign
- legacy command-approval vocabulary still exists in compatibility surfaces and
  should continue to be removed from the primary runtime story
- the current availability rule is intentionally conservative: resumability is
  attached to channel-backed executions, not to generic A2A tasks
- the highest-signal cleanup now sits in config/schema/docs, where `ask` and
  `askFallback` still overstate a deprecated command-approval model

## Next steps

1. Keep `elevationAvailable` as the only resumability gate for
   `PRIVILEGE_ELEVATION_REQUIRED`.
2. Finish removing `ask` / `allowAlways` / `EXEC_APPROVAL_REQUIRED` from docs,
   tests, and schemas where compatibility is no longer needed.
3. Keep grants broker-owned, resource-scoped, and temporary; do not reintroduce
   command approval as a first-class user flow.
4. Decide whether future non-channel operator/API surfaces should make
   `elevationAvailable` true, without weakening the current conservative rule.

## Why this migration exists

The current runtime still carries command-approval plumbing inherited from an
interactive copilot model:

- `ask`
- `allowAlways`
- `EXEC_APPROVAL_REQUIRED`
- command approval resume metadata
- remembered command approvals

That model is not a good fit for autonomous agents.

The actual security boundary already lives in:

- broker policy
- sandbox permissions
- exec policy
- network allowlist
- sandbox lifecycle

So the runtime should move from:

- "approve this command"

to:

- "grant these privileges temporarily"

## Design principles

1. The broker remains the source of truth.
2. `EXEC_POLICY_DENIED` is not an approval candidate.
3. `PRIVILEGE_ELEVATION_REQUIRED` is the only runtime state that may lead to a
   temporary grant.
4. Temporary grants modify effective privileges, not raw command allowlists.
5. Privilege grants should be resource-scoped where practical.
6. Privilege elevation is broker-owned but must be enableable/disableable per
   agent via config.
7. Keep migration incremental and compatible while removing legacy command
   approval plumbing.

## Non-goals

This plan does not include:

- Telegram or any specific operator UI
- long-term admin UX
- durable config editing flow
- a separate operator-channel availability model distinct from broker support

Resource-scoped grants are in scope. A full shell-group model is not required in
v1, but the design should leave room for it.

## Current state

### What already exists

- `EXEC_POLICY_DENIED` and `PRIVILEGE_ELEVATION_REQUIRED` are now distinct
  agent-facing outcomes
- backend permission denials are normalized into `PRIVILEGE_ELEVATION_REQUIRED`
- backend exec denials are normalized into `EXEC_POLICY_DENIED`
- default exec policy now prefers `ask: "off"`
- awaited input and resume metadata already use `kind: "privilege-elevation"` in
  [input_metadata.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/messaging/a2a/input_metadata.ts)
- runtime mapping already turns resumable privilege elevation into canonical
  `INPUT_REQUIRED` metadata and rebuilds privilege grants on resume in
  [runtime_message_mapping.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/runtime_message_mapping.ts)
- runtime capabilities and grant storage already model privilege elevation,
  per-agent enablement, scopes, request timeout, and session TTL in
  [runtime_capabilities.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/shared/runtime_capabilities.ts)
- broker persistence already stores task-scoped and context/session-scoped
  privilege grants, filters expired grants, and consumes `once` grants in
  [persistence.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/orchestration/broker/persistence.ts)
- broker continuation already validates requested grants/scope against awaited
  input and persists privilege grants on resume in
  [task_dispatch.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/orchestration/broker/task_dispatch.ts)
- broker tool dispatch already applies temporary privilege grants before
  permission intersection and only consumes them when actually used in
  [tool_dispatch.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/orchestration/broker/tool_dispatch.ts)
- the broker already gates resumable elevation per agent and keeps disabled
  elevation non-resumable while still returning structured
  `PRIVILEGE_ELEVATION_REQUIRED`

### What still reflects the old model

- `ExecPolicy` still carries `ask` and `askFallback` in
  [sandbox_types.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/sandbox_types.ts),
  even though the current shared backend guard is now static-policy only in
  [exec_policy_guard.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/tools/backends/exec_policy_guard.ts)
- docs and schema still expose legacy command-approval vocabulary in places,
  especially around `askFallback`
- some tests and fixtures still configure `ask` / `askFallback` for
  compatibility, even though they are no longer the conceptual center of the
  runtime
- the runtime now models elevation-channel availability separately from broker
  support; resumability is gated by effective `privilegeElevation.supported`
  plus `elevationAvailable`

## Migration strategy

Implement in six tracks.

## Migration status snapshot

- Track 1: largely complete
- Track 2: complete
- Track 3: complete
- Track 4: complete
- Track 5: complete
- Track 6: remaining cleanup

## Track 1 — Freeze the new semantic boundary

### Objective

Stabilize the runtime meanings before changing storage and resume payloads.

### Required direction

- `EXEC_POLICY_DENIED` stays a hard refusal
- `PRIVILEGE_ELEVATION_REQUIRED` becomes the only resumable policy failure
- legacy `EXEC_APPROVAL_REQUIRED` remains compatibility-only, not a target

### Concrete work

1. Audit recovery messages so they never imply command approval as the primary
   path.
2. Advertise `privilegeElevation.supported` only when broker support is active
   and effective agent policy allows resumable elevation.
3. Ensure new code paths never introduce fresh dependencies on `ask` /
   `allowAlways`.

## Track 2 — Introduce privilege grant payloads

### Objective

Replace command approval metadata with privilege elevation metadata.

### Files

- [input_metadata.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/messaging/a2a/input_metadata.ts)
- [runtime_message_mapping.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/runtime_message_mapping.ts)
- agent policy/config types

### New shape

Replace command-centric approval payloads with something like:

- awaited input:
  - `kind: "privilege-elevation"`
  - `grants: PrivilegeElevationGrantResource[]`
  - `scope: "once" | "task" | "session"`
  - optional human prompt
  - optional continuation token
- resume payload:
  - `kind: "privilege-elevation"`
  - `approved: boolean`
  - `grants?: PrivilegeElevationGrantResource[]`
  - `scope?: ...`

### Notes

- the command may still be present as context for operator understanding
- but it is not the object of the decision anymore
- the broker must only emit resumable privilege-elevation payloads when the
  target agent has elevation enabled in effective policy
- the grant object should already support resource granularity such as:
  - `net.hosts`
  - `write.paths`
  - `read.paths`
  - `env.keys`
  - `ffi.libraries`
  - future shell-oriented policy groups if needed

## Track 3 — Replace command grants with temporary privilege grants

### Objective

Change broker/runtime state from command memory to privilege memory.

### Files

- [runtime_capabilities.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/shared/runtime_capabilities.ts)
- [worker_entrypoint.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/worker_entrypoint.ts)
- [persistence.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/orchestration/broker/persistence.ts)
- effective agent sandbox config / defaults resolution

### Required model

Introduce a grant type such as:

- `kind: "privilege-elevation"`
- `grants: PrivilegeElevationGrantResource[]`
- `scope: "once" | "task" | "session"`
- `grantedAt`
- `source`

Also introduce an effective policy switch such as:

- `sandbox.privilegeElevation.enabled: boolean`
- optional scope/resource limits later if needed

The broker must treat that flag as a hard gate.

### Storage rules

- `once`: one-shot in-memory/use-once broker grant
- `task`: attached to task broker metadata
- `session`: stored in broker context state with TTL-bound expiry

### Important simplification

Current shape:

- `once`, `task`, and `session` are all now modeled
- `session` is broker/context-scoped and TTL-bound, not a durable config change
- privilege elevation still defaults to explicit effective policy, not to global
  implicit enablement

## Track 4 — Apply grants to effective permissions

### Objective

Make temporary grants modify the effective sandbox envelope before permission
intersection is resolved.

### Files

- [tool_dispatch.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/orchestration/broker/tool_dispatch.ts)
- [sandbox_permissions.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/tools/backends/sandbox_permissions.ts)

### Required logic

1. Resolve base agent permissions from config/defaults.
2. Apply temporary privilege grants.
3. Compute effective allowed permissions.
4. Intersect tool permissions against that effective set.

For granular resources, the effective envelope should be composed per resource
type, for example:

- `net` -> merge allowed hosts
- `write` -> merge writable path prefixes
- `read` -> merge readable path prefixes
- `env` -> merge allowed keys
- `ffi` -> merge allowed libraries

If `run` ever participates in elevation, it should do so through broker policy
groups, not per-command approval.

### Invariant

Temporary grants can only widen structural privileges within the broker runtime.

They do **not**:

- mutate durable agent config
- bypass exec policy
- add arbitrary commands to allowlists

## Track 5 — Route `PRIVILEGE_ELEVATION_REQUIRED` into `INPUT_REQUIRED`

### Objective

Reuse the old pause/resume plumbing, but with the new decision object.

### Files

- [tool_dispatch.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/orchestration/broker/tool_dispatch.ts)
- [runtime_message_mapping.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/runtime_message_mapping.ts)
- runtime task handling paths already used for canonical continuation

### Required behavior

- missing privilege -> `PRIVILEGE_ELEVATION_REQUIRED`
- runtime converts that into canonical `INPUT_REQUIRED`
- operator resumes with grant decision metadata
- broker persists/consumes grant
- execution is retried under the elevated effective policy

Only do this when privilege elevation is enabled for the target agent. If not:

- return `PRIVILEGE_ELEVATION_REQUIRED`
- keep it non-resumable in practice
- recovery should point to agent policy/config rather than an operator grant

### Important rule

`EXEC_POLICY_DENIED` does not enter this flow.

## Track 6 — Deprecate and remove command approval plumbing

### Objective

Once privilege elevation works, progressively remove the old command approval
system.

### Files likely affected

- [exec_policy_guard.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/tools/backends/exec_policy_guard.ts)
- [worker_protocol.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/worker_protocol.ts)
- [sandbox_types.ts](/Users/erwanpesle/Documents/GitHub/denoclaw/src/agent/sandbox_types.ts)
- [agent.schema.json](/Users/erwanpesle/Documents/GitHub/denoclaw/schemas/agent.schema.json)
- [agent-sandbox-user-guide.md](/Users/erwanpesle/Documents/GitHub/denoclaw/docs/agent-sandbox-user-guide.md)
- tests referencing `allowAlways` / `EXEC_APPROVAL_REQUIRED`

### Cleanup order

1. Mark `ask`, `allowAlways`, and command approval grants as legacy.
2. Stop adding new coverage around command approval.
3. Remove any remaining command-approval-oriented storage or protocol fields.
4. Remove command approval request/response protocol once privilege elevation
   flow is complete.
5. Simplify docs and schema.

## Recommended implementation order

1. Finish Track 1 cleanup: recovery text, docs, and explicit semantics around
   broker support vs resumability
2. Finish Track 6: remove legacy command-approval vocabulary and dead config
   paths
3. Add any final audit/logging polish around denied/non-resumable elevation
   outcomes

## Testing plan

### Core tests to add

Already covered in code today:

1. `EXEC_POLICY_DENIED` does not create `INPUT_REQUIRED`
2. missing `write` becomes `PRIVILEGE_ELEVATION_REQUIRED`
3. missing privilege with elevation disabled remains non-resumable
4. narrowed grants/scope are validated on resume
5. `once`, `task`, and `session` grants are stored/expired/consumed correctly
6. task/context grants only widen structural permissions and do not bypass exec
   policy

Still worth adding or tightening:

1. explicit coverage for denied/non-resumable elevation when no operator channel
   is available as a first-class concept, if that concept is introduced
2. final cleanup coverage proving legacy command-approval paths are gone once
   Track 6 lands

### Migration safety tests

1. existing broker tool execution still behaves the same when no elevation is
   involved
2. normalized agent-facing errors remain stable
3. legacy `ask` / `askFallback` config still parses safely until removed

## Cleanup checkpoints

### Checkpoint A

Current state:

- privilege grant model exists
- broker can apply temporary structural grants
- no broad command-approval removal yet

### Checkpoint B

Current state:

- `PRIVILEGE_ELEVATION_REQUIRED` is the real resumable policy failure
- broker continuation path works end-to-end
- per-agent enable/disable gate is enforced consistently

### Checkpoint C

Remaining target:

- `ask` / `allowAlways` are legacy or removed
- command approval no longer shapes the runtime design

## Success criteria

This migration is successful when:

- autonomous execution depends on static policy by default
- missing privileges can be granted temporarily through broker state
- the approval decision applies to privileges, not command strings
- agents can explicitly opt in or out of privilege elevation in effective policy
- `EXEC_POLICY_DENIED` and `PRIVILEGE_ELEVATION_REQUIRED` have cleanly separated
  meanings
- the old command approval plumbing stops being the conceptual center of the
  runtime
