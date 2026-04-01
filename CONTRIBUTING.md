# Contributing to DenoClaw

Thanks for contributing.

## Before You Start

- Read [README.md](README.md) for the architecture and local workflow.
- Read [AGENTS.md](AGENTS.md) for the durable engineering rules.
- Keep changes scoped. Avoid drive-by refactors unless they are required to
  complete the requested work safely.

## Development Setup

```bash
deno task dev
deno task dashboard
```

For validation, the expected minimum bar is:

```bash
deno task test
deno task lint
deno task check
```

When touching `tests/` or provider-backed end-to-end flows, also run:

```bash
deno task test:e2e
# or
deno task test:all
```

## Change Guidelines

- Prefer Deno-native primitives over Node-specific patterns.
- Preserve the Broker -> Agent Runtime -> Execution split.
- Do not bypass broker auth, sandboxing, or permission checks for convenience.
- Keep machine-readable contracts stable across broker APIs, CLI, tool
  execution, and A2A flows.
- Add focused tests close to the changed behavior.

## Pull Requests

- Explain the problem and the scope of the fix.
- Call out any deployment, auth, or schema impact explicitly.
- Mention any intentionally deferred follow-up work.
- Keep PRs reviewable; split unrelated changes into separate branches when
  possible.

## Reporting Bugs

When opening a bug report, include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Relevant logs, task IDs, or broker/agent context
- Whether the issue happens in local mode, deploy mode, or both
