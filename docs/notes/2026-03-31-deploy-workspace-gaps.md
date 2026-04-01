# Deploy Workspace Gaps

## Status

Historical snapshot from the 2026-03-31 review.

Validated update as of 2026-04-01:

- `skills/*` deploy loading has landed
- `memories/*` workspace KV routing/listing has landed
- the remaining active gap is the `soul.md` / `agent.json` source-of-truth
  split

See:

- `docs/adrs/adr-018-workspace-kv-backend-for-deploy.md`
- `docs/plans/2026-04-01-agent-config-workspace-source-of-truth-plan.md`

## Historical context

In local mode, agents load all their workspace data from the filesystem
(`data/agents/<id>/`). In deployed mode (Deno Deploy), there is no persistent
filesystem. ADR-009 planned a KV-backed workspace for Deploy, but the
implementation is incomplete.

## What worked in Deploy at review time

- `agent.json` + `soul.md`: baked as string literals in the generated `main.ts`
  at publish time. Functional but requires re-publish on any change.
- Short-term memory (conversations): KV via kvdex with `Deno.openKv()` (no path
  = Deploy managed KV). Fully operational.

## What was missing at review time

### skills/*.md

`SkillsLoader.loadSkills()` calls `Deno.readDir()` + `Deno.readTextFile()` on
the filesystem. On Deno Deploy, the skills directory does not exist. Skills are
not uploaded during publish, neither as Deploy assets nor as KV entries.

Effect: deployed agents have no skills.

### memories/*.md

`listAgentMemoryFiles()` calls `Deno.readDir()` on the memories directory. The
KV workspace backend exists in `file_workspace.ts` (`readWorkspaceKv` /
`writeWorkspaceKv` at key `["workspace", agentId, relativePath]`), but the
`workspaceKv` dependency is not injected in the deploy entrypoint
(`deploy_runtime.ts`).

Effect: deployed agents cannot read or write long-term memory files.

### soul.md hot-reload

Because `soul.md` is baked at publish time, any change requires a full
re-publish cycle. There is no mechanism to update the system prompt at runtime
via KV or API.

## What ADR-009 planned but is not built

1. `deploy:agent sync` step: upload `skills/` and `memories/` content to KV
   before or during deploy.
2. `SkillsLoader` KV fallback: when `Deno.readDir()` fails (no filesystem), read
   skills from KV at `["workspace", agentId, "skills", filename]`.
3. Wire `workspaceKv` into `deploy_runtime.ts` so file tools route to KV on
   Deploy.
4. `isDeploy` detection (`DENO_DEPLOYMENT_ID` env) is in place in
   `file_workspace.ts` but has no effect without the KV dep.

## Exec policy enforcement gap (related)

During the same review, a separate inconsistency was identified in exec policy
enforcement between local and cloud backends:

- `LocalProcessBackend` enforces exec policy (allowlist, operators, inline-eval)
  in its own `execute()` method via `LocalExecPolicyRuntime`.
- `DenoSandboxBackend` only checks `security: "deny"`. All other exec policy
  checks rely on the broker pre-flight (`BrokerToolDispatcher`).
- The ToolRegistry (agent-local path) does not enforce exec policy at all.

This means exec policy responsibility is split across 3 locations depending on
the execution path. A unified guard (e.g., `ExecPolicyGuard` wrapping any
backend) would make enforcement consistent regardless of backend or caller.

## Verification checklist

- [ ] Deploy an agent with skills/*.md and verify they are NOT loaded
- [ ] Verify that memory file read/write fails silently on Deploy
- [ ] Confirm soul.md changes require re-publish
- [ ] Decide: KV workspace sync at publish time vs runtime KV fallback
- [ ] Wire workspaceKv into deploy_runtime.ts
- [ ] Unify exec policy enforcement across backends
