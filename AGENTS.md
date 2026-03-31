# AGENTS.md — DenoClaw

## Scope

DenoClaw is a Deno-first runtime for brokered multi-agent workflows.

This document should contain durable engineering rules, not volatile project
inventory. Do not turn it into a list of ADRs, a detailed tree of directories,
or a changelog of temporary implementation decisions.

## Core Identity

- Prefer Deno-native primitives first: `Deno.serve`, `Deno.openKv`,
  `Deno.Command`, `Worker`, `fetch`, Deno Deploy, and Deno Sandbox.
- Avoid Node-specific patterns when a Deno-native approach exists. If an npm
  package is used, it must not weaken the runtime model or the deploy story.
- Preserve local/deploy parity: same semantics, different transport and
  isolation boundaries.
- Keep the architecture split clear: **Broker -> Agent Runtime -> Execution**.
- The Broker is the control plane: ingress, auth, routing, LLM proxying,
  scheduling, observability, and durable coordination.
- Agent runtimes are reactive endpoints with state, not hidden daemons and not
  schedulers.
- Arbitrary code and tool execution must happen in Sandbox (cloud) or isolated
  subprocesses (local), never directly inside the deployed agent runtime.
- Public ingress is broker-first. Do not design flows that depend on humans or
  external systems talking directly to agent runtimes.
- Permissions are deny-by-default and explicit. Effective execution permissions
  come from the intersection of tool requirements and agent policy.

## AX Principles

All agent-facing interfaces must optimize for execution reliability, not for
human convenience.

> Reliability comes from better execution interfaces, not from longer prompts.

| # | Principle                   | Rule                                                                                                  |
| - | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1 | **No Verb Overlap**         | Commands and operations must have distinct names and distinct semantics.                              |
| 2 | **Safe Defaults**           | Mutations default to the safest behavior, including `dry_run: true` on agent-facing write operations. |
| 3 | **Structured Outputs**      | Return machine-readable objects, not prose-only success messages.                                     |
| 4 | **Machine-Readable Errors** | Errors must expose `code`, `context`, and `recovery`.                                                 |
| 5 | **Fast Fail Early**         | Validate at the boundary and reject bad input before it travels deeper.                               |
| 6 | **Deterministic Outputs**   | Same inputs should produce the same outputs; avoid hidden time/randomness dependencies.               |
| 7 | **Explicit Over Implicit**  | No magic defaults, no silent mode switching, no hidden side effects.                                  |
| 8 | **Composable Primitives**   | Build small pieces that can be recombined instead of monolithic flows.                                |
| 9 | **Narrow Contracts**        | Accept the minimum required input and return the minimum useful output.                               |

Operational loop: **Plan -> Scope -> Act -> Verify -> Recover**.

## SOLID / Design Rules

- **Single Responsibility**: each module owns one concern. Do not blend broker,
  runtime, transport, provider, config, and tool logic into one place.
- **Open/Closed**: extend the system by adding adapters, tools, providers, or
  ports, not by growing switch-heavy God modules.
- **Liskov Substitution**: interchangeable implementations must preserve the
  contract, not just the type signature.
- **Interface Segregation**: prefer small ports and focused request/response
  shapes over broad interfaces.
- **Dependency Inversion**: domain and runtime logic depend on stable
  abstractions, not on deploy plumbing, CLI wiring, or infrastructure details.
- Prefer explicit ports/adapters boundaries over cross-layer reach-through.
- Avoid God objects, ambient coupling, and hidden runtime state.

## Coding Rules

- Use TypeScript with `.ts` extensions and the repo import map.
- Do not use inline `npm:` or `jsr:` specifiers in source files; register them
  in `deno.json`.
- Prefer structured domain errors over raw strings.
- Preserve machine-readable contracts across CLI, broker APIs, tool execution,
  and inter-agent communication.
- Keep comments for non-obvious logic only.
- Avoid hidden behavior tied to the current clock, random IDs, or environment
  side effects when those values should be injected explicitly.
- Do not add convenience shortcuts that bypass broker auth, sandboxing, or
  permission checks.

## Security Rules

- The Broker is the canonical public entrypoint.
- Do not move arbitrary execution into the broker or deployed agent runtime.
- Do not weaken sandbox boundaries to simplify local debugging or deploy flows.
- Do not make peer-to-peer communication implicitly open; trust must stay
  explicit and closed by default.
- Do not commit secrets, tokens, or live environment values.

## Change Discipline

- Keep changes scoped to the request.
- Prefer stable rules over implementation-specific documentation.
- Do not add repo-specific clutter here when the rule will age quickly.
- Do not add fallback magic or "auto" behavior where explicit configuration is
  safer.
- Do not refactor unrelated areas unless the requested change requires it.
- Do not change versioning, deployment conventions, or auth behavior unless the
  task explicitly calls for it.

## Verification

- Minimum bar before shipping code changes: `deno task test`, `deno task lint`,
  `deno task check`.
- Prefer narrow tests close to the changed behavior.
- Test invariants and edge cases before optimizing happy-path ergonomics.

## What This File Should Not Become

- Not an ADR index.
- Not a directory tree.
- Not a temporary migration log.
- Not a list of current filenames, deploy app names, or one-off operational
  steps.

If a rule will likely change with the next refactor, it probably does not belong
in `AGENTS.md`.
