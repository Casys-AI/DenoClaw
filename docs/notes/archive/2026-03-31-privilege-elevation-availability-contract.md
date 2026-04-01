# 2026-03-31 — Privilege elevation availability contract

## Context

The broker-governed temporary privilege elevation flow now distinguishes:

- privilege elevation supported by broker policy and effective agent config
- privilege elevation actually available for the current execution

Those are related but not identical.

The point of this contract is simple:

- `EXEC_POLICY_DENIED` stays a static policy refusal
- `PRIVILEGE_ELEVATION_REQUIRED` stays the structural privilege failure
- only executions with a real continuation surface become resumable

## Implemented contract

The current runtime/broker contract distinguishes three outcomes:

1. `EXEC_POLICY_DENIED`
2. `PRIVILEGE_ELEVATION_REQUIRED` with `privilegeElevationSupported: false`
3. `PRIVILEGE_ELEVATION_REQUIRED` with `privilegeElevationSupported: true` plus
   an explicit `elevationAvailable: true | false`

In practice:

- `EXEC_POLICY_DENIED`
  - command/tool use is blocked by static exec policy
  - non-resumable
  - recovery points to config / allowlist changes only
- `PRIVILEGE_ELEVATION_REQUIRED` with `elevationAvailable: true`
  - action is acceptable in principle
  - current sandbox envelope is insufficient
  - a real continuation surface exists for the task
  - resumable privilege-elevation flow is allowed
- `PRIVILEGE_ELEVATION_REQUIRED` with `elevationAvailable: false`
  - action is acceptable in principle
  - current sandbox envelope is insufficient
  - but the current execution has no usable elevation channel
  - non-resumable in practice

## Current availability rule

Today, the broker exposes availability conservatively:

- `elevationAvailable: true`
  - for channel-backed tasks with persisted broker channel metadata
  - for delegated A2A child tasks that inherit the same operator lineage through
    explicit `parentTaskId`
- `elevationAvailable: false`
  - direct broker tool requests
  - agent-to-agent tasks with no rooted channel continuation path
  - local/runtime flows with no attached elevation surface

This means:

- channel-rooted flows may pause into `INPUT_REQUIRED`
- plain A2A flows do not become resumable just because privilege elevation is
  supported in theory
- delegated flows only become resumable when the parent lineage is explicit and
  broker-validated

## Error context

The structured error context may expose:

- `privilegeElevationSupported`
- `elevationAvailable`
- `elevationReason`
- `privilegeElevationScopes`
- `privilegeElevationRequestTimeoutSec`
- `privilegeElevationSessionGrantTtlSec`

Current `elevationReason` values in use:

- `no_channel`
- `disabled_for_agent`
- `broker_unsupported`

`elevationAvailable` must never be `true` when `privilegeElevationSupported` is
`false`.

## Runtime consequence

The runtime only turns `PRIVILEGE_ELEVATION_REQUIRED` into canonical
`INPUT_REQUIRED` when:

- privilege elevation is supported
- `suggestedGrants` exist
- `elevationAvailable` is not `false`

Otherwise the failure remains structured but non-resumable, and the agent keeps
the denial in-band as a normal tool error.

## Consequences

- legacy command approval is not the control surface anymore
- broker support and channel availability are separate concerns
- “no channel” is now an explicit structured denial, not an implicit fallback
- resumability is attached to the execution context, not just to global broker
  capability

## Follow-up

Still intentionally out of scope here:

- final audit event schema for attempted elevation with no channel
- operator transport / UI
- richer availability sources beyond current channel-backed execution
