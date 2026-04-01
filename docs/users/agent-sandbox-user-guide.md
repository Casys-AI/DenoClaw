# Agent Sandbox User Guide

This guide explains the current sandbox model for agents.

## Mental Model

There are four separate layers:

1. `allowedPermissions` What the agent may do at all: read files, write files,
   open the network, or run commands.
2. `execPolicy` Which commands are allowed once the agent has `run`.
3. `shell` How commands are executed:
   - `direct`: `Deno.Command(binary, args)`
   - `system-shell`: a real shell interpreter (`sh -c`)
4. `privilegeElevation` Whether the broker may offer bounded, temporary
   privilege elevation when the command is allowed in principle but the current
   sandbox envelope is too narrow.

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
      "allowedCommands": ["git", "deno", "npm"]
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
      "security": "full"
    },
    "shell": {
      "mode": "system-shell"
    },
    "privilegeElevation": {
      "enabled": true,
      "scopes": ["task", "session"],
      "requestTimeoutSec": 300,
      "sessionGrantTtlSec": 1800
    }
  }
}
```

- Allows a real shell with pipes, redirects, command chaining, and shell
  builtins
- Requires `execPolicy.security = "full"`
- Can request bounded privilege elevation through the broker if configured

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
  "security": "deny"
}
```

### `security: "allowlist"`

Allow only listed binaries in `direct` mode.

```json
{
  "security": "allowlist",
  "allowedCommands": ["git", "deno", "npm"]
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
  "security": "full"
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
    "security": "full"
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

## `privilegeElevation`

Privilege elevation is broker-controlled. It does not approve commands; it
temporarily widens the sandbox envelope when a command is already acceptable in
principle.

Example:

```json
{
  "privilegeElevation": {
    "enabled": true,
    "scopes": ["once", "task", "session"],
    "requestTimeoutSec": 300,
    "sessionGrantTtlSec": 1800
  }
}
```

Fields:

- `enabled` Whether this agent may enter a resumable privilege-elevation flow
- `scopes` Which scopes are allowed for grants
- `requestTimeoutSec` How long an elevation request may stay pending
- `sessionGrantTtlSec` How long a session-scoped grant remains active

Typical use:

- `EXEC_POLICY_DENIED` The command is outside policy and must be fixed in config
- `PRIVILEGE_ELEVATION_REQUIRED` The command is acceptable, but the current
  sandbox lacks privileges such as `write` or `net`

## Recommendations

- Default to `shell.mode = "direct"` for most agents
- Use `security: "allowlist"` for normal dev agents
- Use `system-shell` only for agents that really need shell composition
- Prefer cloud sandbox for powerful autonomous agents
- Keep `networkAllow` narrow even when `run` is enabled
- Enable `privilegeElevation` only when the broker/operator flow is intended

## Common Mistakes

### "The agent has `run`, why does `echo hi | cat` fail?"

Because `run` only allows command execution. Pipes require
`shell.mode = "system-shell"`.

### "Why does `system-shell` require `security: \"full\"`?"

Because once a shell interpreter is allowed, binary allowlists are no longer a
reliable control boundary.

### "Can I use `system-shell` locally?"

Yes. It is allowed, but it is a higher-trust mode and logs a warning by default.

### "Why did the agent get `PRIVILEGE_ELEVATION_REQUIRED`?"

Because the command passed exec policy, but the sandbox still lacks some
required capability or resource grant, such as `write` access to a path or `net`
access to a host.
