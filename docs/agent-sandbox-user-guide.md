# Agent Sandbox User Guide

This guide explains how to configure agent sandbox permissions from a user point
of view.

## Mental Model

There are three separate layers:

1. `allowedPermissions` What the agent is allowed to do at all: read files,
   write files, open the network, or run commands.

2. `execPolicy` Which shell commands are allowed once the agent has `run`.

3. `shell` How commands are executed:
   - `direct`: `Deno.Command(binary, args)`
   - `system-shell`: a real shell interpreter (`sh -c`)

`run` is not the same thing as `system-shell`.

## Quick Reference

### Read-only analyst

```json
{
  "sandbox": {
    "allowedPermissions": ["read", "net"],
    "networkAllow": ["api.stripe.com", "api.mixpanel.com"]
  }
}
```

- Can read files and call approved APIs
- Cannot write files
- Cannot run commands

### Local dev agent

```json
{
  "sandbox": {
    "backend": "local",
    "allowedPermissions": ["read", "write", "run"],
    "execPolicy": {
      "security": "allowlist",
      "allowedCommands": ["git", "deno", "npm"],
      "ask": "on-miss",
      "askFallback": "deny"
    },
    "shell": {
      "mode": "direct"
    }
  }
}
```

- Safe default for coding workflows
- Allows commands like `git status` or `deno task test`
- Rejects pipes, redirects, `&&`, `sh -c`, wrapper forms like `env sh -c`, and
  similar shell-composition syntax

### Ops agent with full shell

```json
{
  "sandbox": {
    "backend": "cloud",
    "allowedPermissions": ["read", "write", "run", "net"],
    "networkAllow": ["api.deno.com"],
    "execPolicy": {
      "security": "full",
      "ask": "always"
    },
    "shell": {
      "mode": "system-shell"
    }
  }
}
```

- Allows a real shell with pipes, redirects, command chaining, and shell
  builtins
- Requires `execPolicy.security = "full"`
- Recommended for powerful agents, especially in cloud sandbox mode

## `allowedPermissions`

Supported values:

- `read`
- `write`
- `run`
- `net`
- `env`
- `ffi`

Examples:

- No `run`: the agent cannot use the `shell` tool
- No `net`: even if a command runs, it cannot access the network
- No `write`: the agent can inspect but not modify files

## `execPolicy`

### `security: "deny"`

Block shell execution entirely.

```json
{
  "security": "deny",
  "ask": "off"
}
```

### `security: "allowlist"`

Allow only listed binaries in `direct` mode.

```json
{
  "security": "allowlist",
  "allowedCommands": ["git", "deno", "npm"],
  "ask": "on-miss",
  "askFallback": "deny"
}
```

This mode still blocks:

- `sh -c`
- `bash -c`
- `/bin/sh -c`
- `env sh -c`
- pipes: `|`
- redirects: `>`, `>>`, `<`
- chaining: `&&`, `||`, `;`
- command substitution: `$(...)`
- inline eval such as `python -c` unless `allowInlineEval` is enabled

### `security: "full"`

No command allowlist.

```json
{
  "security": "full",
  "ask": "always"
}
```

This means:

- in `shell.mode = "direct"`: any direct command is allowed
- in `shell.mode = "system-shell"`: required, because shell interpreters cannot
  be reliably constrained by binary allowlists

## `shell`

### `shell.mode = "direct"`

Default mode.

```json
{
  "shell": {
    "mode": "direct"
  }
}
```

Use this when you want control and predictability.

Examples that work:

- `git status`
- `deno task test`
- `python3 script.py`
- `bash ./scripts/deploy.sh` if `bash` is allowed by policy

Examples that do not work:

- `cd repo && deno task test`
- `ls | grep foo`
- `echo hi > out.txt`

### `shell.mode = "system-shell"`

Opt-in full shell mode.

```json
{
  "execPolicy": {
    "security": "full",
    "ask": "always"
  },
  "shell": {
    "mode": "system-shell"
  }
}
```

Use this when you need real shell semantics:

- pipes
- redirects
- chaining
- shell builtins
- globbing
- substitutions

On `backend: "local"`, this is allowed but emits a warning by default because
the host shell becomes part of the trust model.

You can silence that warning:

```json
{
  "shell": {
    "mode": "system-shell",
    "warnOnLocalSystemShell": false
  }
}
```

### `shell.enabled = false`

Disable the shell tool even if the runtime exposes it.

```json
{
  "shell": {
    "enabled": false
  }
}
```

## Approval Settings

### `ask: "off"`

Run or deny immediately.

### `ask: "on-miss"`

Ask only when the command is not covered by policy.

### `ask: "always"`

Always require approval.

### `askFallback`

What to do if the approval channel is unavailable:

- `deny`: fail closed
- `allowlist`: allow only commands that would already pass without approval

## Recommendations

- Default to `shell.mode = "direct"` for most agents
- Use `security: "allowlist"` for normal dev agents
- Use `system-shell` only for agents that really need shell composition
- Prefer cloud sandbox for powerful autonomous agents
- Keep `networkAllow` narrow even when `run` is enabled

## Common Mistakes

### "The agent has `run`, why does `echo hi | cat` fail?"

Because `run` only allows command execution. Pipes require
`shell.mode = "system-shell"`.

### "Why does `system-shell` require `security: \"full\"`?"

Because once a shell interpreter is allowed, binary allowlists are no longer a
reliable control boundary.

### "Can I use `system-shell` locally?"

Yes. It is allowed, but it is a higher-trust mode and logs a warning by default.
