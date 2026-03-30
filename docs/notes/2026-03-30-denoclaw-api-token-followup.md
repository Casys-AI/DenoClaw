# DENOCLAW_API_TOKEN Follow-up

## Status

Deferred on purpose during live broker/agent deploy testing.

## Current constraint

`DENOCLAW_API_TOKEN` currently has to stay consistent across:

- the deployed broker app
- the local machine running `denoclaw publish`
- the agent app environment used for broker-authenticated wake-up

If those drift, broker registration fails with `401 AUTH_FAILED`.

## Why this is deferred

Right now the priority is finishing real deploy-path validation:

- broker deploy
- agent publish
- wake-up `POST /tasks`
- agent socket `/agent/socket`
- end-to-end broker/agent execution

Refactoring token generation and persistence now would mix:

- transport/runtime debugging
- operator secret management changes

That would make failures harder to classify.

## Required follow-up

Later, we should make `DENOCLAW_API_TOKEN` have a single source of truth with:

- stable generation policy
- automatic broker sync on deploy
- automatic local persistence/update for later `publish`
- explicit rotation story
- no silent drift between local config, `.env`, and deployed broker env

## Rule for now

For current real-world tests:

- keep `DENOCLAW_API_TOKEN` stable
- do not redesign its lifecycle yet
- only revisit after agent deploy/runtime path is green
