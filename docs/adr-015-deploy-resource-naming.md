# ADR-015: Deploy Resource Naming

**Status:** Accepted
**Date:** 2026-03-30
**Related:** ADR-008, ADR-013

## Context

DenoClaw now has multiple deploy-time resource families that must stay easy to
distinguish in operations:

- broker app
- agent apps
- broker KV
- agent KV
- agent execution sandboxes
- hostnames derived from app slugs

The current live state still contains legacy names such as:

- broker app: `denoclaw`
- agent app: `alice`
- agent KV: `alice-kv`

Those names are workable, but they are not strong enough:

- role is not always visible in the name
- the broker app and project name can collapse into the same word
- bare agent ids like `alice` do not scale well in dashboards, logs, cleanup
  scripts, or infra inventories
- future automation becomes harder because names are not self-describing

We need a canonical convention that is explicit, stable, and operationally
unambiguous.

## Decision

Adopt the following canonical naming convention for DenoClaw deploy resources.

### Broker

- broker app slug: `denoclaw-broker`
- broker KV database: `denoclaw-broker-kv`
- broker hostname: `https://denoclaw-broker.<org>.deno.net`

### Agents

- agent app slug: `denoclaw-agent-<agent-id>`
- agent KV database: `denoclaw-agent-<agent-id>-kv`
- agent sandbox instance: `denoclaw-agent-<agent-id>-sandbox`
- agent hostname: `https://denoclaw-agent-<agent-id>.<org>.deno.net`

### Rules

- deploy resource names must not be bare agent ids like `alice`
- deploy resource names must not rely on ambiguous generic names like
  `denoclaw`
- the role must always be visible in the name: `broker`, `agent`, `sandbox`,
  `kv`
- hostnames follow directly from app slugs and therefore inherit the same
  convention

## Rationale

This naming is stronger because it makes the role obvious everywhere:

- Deno Deploy dashboard
- KV database list
- logs
- sandboxes
- local config
- future automation and cleanup scripts

It also reduces collision risk between:

- the broker app
- agent apps
- agent execution sandboxes
- data stores

## Legacy state

Existing live resources that still use older names should be treated as legacy,
not as the canonical convention.

Examples:

- `denoclaw`
- `alice`
- `alice-kv`

## Migration rule

Do not silently switch naming helpers in code and continue publishing as if
nothing changed.

If we adopt this convention in runtime code and deploy flows, we should do it
intentionally:

1. update naming helpers and operator docs
2. redeploy the broker under the canonical broker slug
3. republish agents under canonical agent slugs
4. verify broker URL, registration, KV assignment, and runtime health
5. retire legacy apps and databases only after verification

## Consequences

**Positive:**

- deploy resources become self-describing
- operator mistakes become less likely
- broker vs agent vs sandbox is obvious in every infra view
- future scripts can derive names predictably

**Negative:**

- migration must be explicit
- old deploy resources will temporarily coexist with canonical ones
- local config and docs must clearly distinguish legacy live names from the
  canonical target
