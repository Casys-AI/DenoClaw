# Publish Workspace Reconcile Follow-up

## Status

Follow-up after the initial `publish` workspace sync landed.

## Current behavior

`denoclaw publish` now snapshots local `skills/*.md` and `memories/*.md` into
the deploy revision and bootstraps the agent KV workspace on first boot.

The sync mode is explicit:

- default = `preserve`
- optional = `--force`

Semantics:

- `preserve` creates missing tracked files but keeps conflicting remote content
- `force` overwrites conflicting tracked files for that publish revision
- neither mode deletes remote-only files

This is intentionally safer than pretending we have a real bidirectional sync.

## Remaining limitation

The current model is not yet "git-like":

- no `status` command for local vs remote workspace drift
- no `diff` view for tracked files
- no explicit delete propagation for files removed locally
- no pull/reconcile flow when remote KV evolved after a previous publish
- no conflict model beyond "preserve" vs "force"

## Proposed future direction

Add an explicit reconcile workflow rather than more publish-time magic:

1. `denoclaw publish --dry-run` or `denoclaw workspace status`
   - show missing, changed, and remote-only files
2. `denoclaw workspace diff <agent>`
   - inspect content drift before overwriting
3. `denoclaw publish --force`
   - keep as the blunt "push tracked local state" path
4. future explicit delete / prune mode
   - only with opt-in semantics

## Why this should stay explicit

The deployed KV workspace can evolve independently because the agent may create
or update skills and memory files while online. Silent bidirectional sync or
automatic delete behavior would be risky without a real conflict model.

So the next step should be better observability and reconciliation, not more
implicit overwrite behavior.
