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

**In GUI clients** (Cursor, Claude Desktop): policy-only mode.
Rules auto-allow and auto-block. No interactive prompt needed.

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

## Commands

```
agentwall setup [--dry-run]          Auto-detect and wrap all MCP configs
agentwall setup <runtime>            Print manual setup instructions
agentwall undo                       Restore all original MCP configs
agentwall proxy -- <command> [args]  Wrap a single MCP server
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

## Version history

| Version | What gets intercepted | How |
|---|---|---|
| v0.1 | Shell commands | OpenClaw WebSocket adapter |
| v0.2 | All tool calls in OpenClaw | Native OpenClaw plugin |
| v0.3 | Everything MCP-speaking | Protocol-level MCP proxy |
| v0.4 | Same + database rules | Policy engine v2 + zero-friction setup |

## License

MIT
