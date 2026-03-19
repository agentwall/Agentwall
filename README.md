# AgentWall

Your AI agent has root access to your filesystem, your database, and your shell.
Do you know what it's doing?

AgentWall is a policy-enforcing MCP proxy. It sits between your AI client and
every MCP server, intercepts every tool call, and enforces your rules before
anything executes.

<!-- TODO: add demo GIF here -->

## Install

```bash
npx agentwall setup
```

That's it. AgentWall detects your MCP configurations (Claude Desktop, Cursor,
Windsurf, Claude Code), wraps every server with the proxy, backs up your
originals, and tells you to restart. No JSON editing. No reading docs.

To install globally first:

```bash
npm install -g agentwall
agentwall setup
```

Requires Node.js >= 22.

## What it protects

| Client | Status |
|---|---|
| Claude Desktop | Supported |
| Cursor | Supported |
| Claude Code | Supported (with interactive approval) |
| Windsurf | Supported |
| Any MCP client | Supported |

**In GUI clients** (Cursor, Claude Desktop): web-based approval.
Rules auto-allow and auto-block. `ask` rules show in the browser UI.

**In terminal clients** (Claude Code): full interactive approval.
You see every tool call and decide in real time.

## Your policy, not the client's

Claude Desktop has an "Always allow" button. AgentWall ignores it.

```
18:14:47   mcp   DENY    policy   list_directory   <- BLOCKED despite Claude "Always allow"
```

Client approval does not override AgentWall policy. Your YAML file is the
final word.

## Example: protect your database

```yaml
deny:
  - tool: "*"
    match:
      sql: "drop *"
  - tool: "*"
    match:
      sql: "truncate *"

ask:
  - tool: "*"
    match:
      sql: "delete *"
  - tool: "*"
    match:
      sql: "alter *"
```

AgentWall blocks DROP and TRUNCATE silently. It prompts you before DELETE
and ALTER. Everything else runs normally. Matching is case-insensitive.

## Policy

AgentWall evaluates rules in order: **deny -> allow -> ask**.
Unmatched actions default to **ask** (never silently allow unknowns).

Run `agentwall init` to create `~/.agentwall/policy.yaml` with sensible
defaults. The default policy protects credentials, blocks pipe-to-shell
attacks, prevents database destruction, and asks before destructive
shell commands.

### Rule fields

| Field | Description | Example |
|---|---|---|
| `command` | Shell command glob | `"rm -rf *"` |
| `path` | File path glob | `~/.ssh/**` |
| `tool` | MCP tool name glob | `"write_file"` |
| `match` | Argument content matching | `sql: "drop *"` |
| `url` | URL pattern (shorthand) | `"*.competitor.com/*"` |

Glob patterns: `*` matches any characters except `/`, `**` matches
everything including `/`. Special path value: `outside:workspace`.

All fields in a rule use AND logic. The `match` field maps argument
names to glob patterns and is case-insensitive for SQL safety.

### Full policy example

```yaml
deny:
  - path: ~/.ssh/**
  - path: ~/.aws/**
  - command: "curl * | *"
  - command: "rm -rf /"
  - tool: "*"
    match:
      sql: "drop *"
  - tool: "*"
    match:
      sql: "truncate *"

ask:
  - tool: "*"
    match:
      sql: "delete *"
  - command: "rm -rf *"
  - command: "sudo *"
  - path: outside:workspace

allow:
  - path: workspace/**
```

## Web UI

AgentWall includes a local web UI for clients that don't have a terminal
(Cursor, Claude Desktop).

It starts automatically when needed, or run it manually:

```bash
agentwall ui
# -> Web UI available at http://localhost:7823
```

**Approval page** (`/`) -- approve or deny tool calls from your browser.
Auto-denies after 30 seconds if no response.

**Policy editor** (`/policy`) -- edit your rules visually or in raw YAML.
Both modes edit the same file. Changes apply instantly.

**Log viewer** (`/log`) -- searchable view of everything your agent has done.

The web UI is localhost-only. No auth, no external connections.

## Commands

```
agentwall setup [--dry-run]          Auto-detect and wrap all MCP configs
agentwall setup <runtime>            Print manual setup instructions
agentwall undo                       Restore all original MCP configs
agentwall proxy -- <command> [args]  Wrap a single MCP server
agentwall ui [--port 7823]           Start the web UI
agentwall init                       Create default policy
agentwall status                     Show protection status
agentwall replay [N]                 Show recent audit log entries
agentwall --version                  Print version
```

## How it works

AgentWall is an MCP proxy. When your AI client starts an MCP server, it
actually starts AgentWall, which starts the real server behind it.
AgentWall forwards `tools/list` unchanged so the client sees the real
tools. On `tools/call`, AgentWall evaluates the call against your policy
before forwarding it.

```
Client  <-->  AgentWall Proxy  <-->  Real MCP Server
                   |
             policy.yaml
```

The client never knows AgentWall is there. The real server never knows
it's being proxied. AgentWall is invisible to both sides.

## Undo

```bash
agentwall undo
```

Restores all original MCP configs from backups. One command, fully
reversible.

## v0.5

**Hot-reload** — Edit `~/.agentwall/policy.yaml` and changes apply instantly.
No gateway restart, no proxy restart.

**Rate limiting** — Cap how many times an agent can call a tool per minute.
Catches runaway loops before they cause damage.

```yaml
limits:
  - tool: exec
    max: 10
    window: 60    # max 10 shell commands per minute
```

When the limit is hit the agent receives a clear message:
`AgentWall: exec rate limit reached (10/60s). Wait 43 seconds.`

## What AgentWall protects against

- Accidental destruction — rm -rf, DROP TABLE, TRUNCATE
- Credential access — ~/.ssh, ~/.aws, ~/.gnupg
- Shell config modification — ~/.bashrc, ~/.zshrc
- Operations outside your workspace
- Force pushes and destructive git operations
- Runaway agents — rate limiting per tool per session
- Common obfuscation patterns — eval, base64 decode

## What AgentWall does not protect against

- **Obfuscated commands** — `eval $(echo cm0= | base64 -d)`.
  Pattern matching sees eval, not the decoded payload.

- **Data exfiltration via request body**.
  AgentWall sees the curl command, not the network payload.

- **Prompt injection**.
  Would require scanning every file before the agent reads it.

- **Multi-step attacks**.
  Each tool call is evaluated independently.
  Read credentials then curl them out crosses two separate calls.

AgentWall is a policy engine, not a security sandbox.
The right complement is OS-level isolation — run your agent in a
container with no credential access in the first place.
AgentWall and OS isolation are complementary, not alternatives.

## Version history

| Version | What gets intercepted | How |
|---|---|---|
| v0.1 | Shell commands | OpenClaw WebSocket adapter |
| v0.2 | All tool calls in OpenClaw | Native OpenClaw plugin |
| v0.3 | Everything MCP-speaking | Protocol-level MCP proxy |
| v0.4 | Same + database rules | Policy engine v2 + zero-friction setup |
| v0.5 | Same + rate limiting | Hot-reload + rate limiting |
| v0.6 | Same + web UI | Approval UI, policy editor, log viewer |

## License

MIT
