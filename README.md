# AgentWall

**AgentWall — run AI agents safely on your local machine**

Your AI agent has root access to your filesystem, your database, and your shell. Do you know what it's doing?

AgentWall is a policy-enforcing MCP proxy. It sits between your AI client and every MCP server, intercepts every tool call, and enforces your rules before anything executes.

## The killer feature

AI clients have their own approval flows. AgentWall ignores them.

Claude Desktop approved the call. OpenClaw approved the call. AgentWall blocked both.

```
18:14:47   mcp        DENY    policy   list_directory   ← BLOCKED despite Claude "Always allow"
18:14:51   openclaw   DENY    policy   exec             ← BLOCKED despite OpenClaw approval
```

Your YAML policy is the final word. Not the client. Not the model. You.

---

## Install

```bash
npx agentwall setup
```

AgentWall detects Claude Desktop, Cursor, Windsurf, Claude Code, and OpenClaw.
Wraps every MCP server automatically. Backs up your originals. Zero JSON editing.

```bash
# Or install globally first
npm install -g agentwall
agentwall setup
```

Requires Node.js >= 22.

---

## Supported clients

| Client | How |
|---|---|
| Claude Desktop | MCP proxy — web UI approval |
| Cursor | MCP proxy — web UI approval |
| Windsurf | MCP proxy — web UI approval |
| Claude Code | MCP proxy — terminal approval |
| OpenClaw | Native plugin — `before_tool_call` hook |
| Any MCP client | MCP proxy |

**GUI clients** (Cursor, Claude Desktop, Windsurf): approval requests appear in your browser at `http://localhost:7823`. Auto-denies after 30 seconds if no response.

**Terminal clients** (Claude Code, OpenClaw): interactive `y/n/a` prompt. Session memory — press `a` to always allow an operation for the current session.

---

## Web UI

```bash
agentwall ui
# Web UI available at http://localhost:7823
```

Three pages:

**Approval** `/` — approve or deny tool calls from your browser. Works for Cursor and Claude Desktop which have no terminal. Real-time via WebSocket.

**Policy editor** `/policy` — edit rules visually or in raw YAML. Both modes edit the same file. Changes apply instantly via hot-reload.

**Log viewer** `/log` — searchable, filterable view of everything your agent has done. Filter by runtime, decision, tool name.

The web UI is localhost-only. No auth. No external connections.

---

## OpenClaw

AgentWall includes a native OpenClaw plugin that hooks into `before_tool_call` — intercepting `exec`, `read`, `write`, `edit`, `apply_patch`, and `process` before they execute.

```bash
openclaw plugins install agentwall --link
```

The plugin runs independently of the MCP proxy. Both can run simultaneously across different runtimes, logging to the same audit file.

---

## Policy

AgentWall evaluates rules in order: **deny → allow → ask**.
Unmatched calls default to **ask** — never silently allow unknowns.

```bash
agentwall init    # creates ~/.agentwall/policy.yaml with sensible defaults
```

### Rule fields

| Field | Description | Example |
|---|---|---|
| `command` | Shell command glob | `"rm -rf *"` |
| `path` | File path glob | `~/.ssh/**` |
| `tool` | MCP tool name glob | `"write_file"` |
| `match` | Argument content matching | `sql: "drop *"` |
| `url` | URL pattern | `"*.competitor.com/*"` |

Glob patterns: `*` matches any characters except `/`. `**` matches everything including `/`. All fields in a rule use AND logic. `match` is case-insensitive for SQL safety.

Special path value: `outside:workspace` — matches any path outside the current working directory.

### Protect your database

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

DROP and TRUNCATE blocked silently. DELETE and ALTER prompt for approval. Everything else runs normally.

### Full default policy

```yaml
deny:
  # Credentials — never access
  - path: ~/.ssh/**
  - path: ~/.aws/**
  - path: ~/.gnupg/**

  # Shell config — prevent persistence
  - path: ~/.bashrc
  - path: ~/.zshrc

  # Shell — never pipe from internet
  - command: "curl * | *"
  - command: "wget * | *"

  # Database — never drop or truncate
  - tool: "*"
    match:
      sql: "drop *"
  - tool: "*"
    match:
      sql: "truncate *"

ask:
  # Shell — confirm destructive commands
  - command: "rm -rf *"
  - command: "sudo *"
  - command: "dd *"

  # Git — confirm pushes to main
  - tool: exec
    match:
      command: "git push*main*"

  # Database — confirm writes
  - tool: "*"
    match:
      sql: "delete *"
  - tool: "*"
    match:
      sql: "alter *"

  # Files outside workspace
  - tool: "*"
    path: outside:workspace

allow:
  # Everything inside workspace is trusted
  - path: workspace/**

limits:
  - tool: exec
    max: 30
    window: 60    # max 30 shell commands per minute
```

---

## Rate limiting

Cap how many times an agent can call a tool per session window. Catches runaway loops before they cause damage.

```yaml
limits:
  - tool: exec
    max: 10
    window: 60    # max 10 shell commands per minute
  - tool: "*"
    max: 200
    window: 300   # max 200 total tool calls per 5 minutes
```

When the limit is hit, the agent receives a clear message it can read:
`AgentWall: exec rate limit reached (10/60s). Wait 43 seconds.`

---

## Hot-reload

Edit `~/.agentwall/policy.yaml` and changes apply instantly. No restart required for the proxy or the gateway.

```
[AgentWall] Policy reloaded: ~/.agentwall/policy.yaml
```

---

## Commands

```
agentwall setup [--dry-run]          Auto-detect and wrap all MCP configs
agentwall undo                       Restore all original MCP configs from backup
agentwall proxy -- <cmd> [args]      Wrap a single MCP server
agentwall ui [--port 7823]           Start the web UI standalone
agentwall init                       Create default policy at ~/.agentwall/policy.yaml
agentwall status                     Show protection status and today's decision counts
agentwall replay [N]                 Show recent audit log entries (color-coded)
agentwall --version                  Print version
```

### Undo

```bash
agentwall undo
```

Restores all original MCP configs from backups created during `agentwall setup`. One command, fully reversible.

---

## Audit log

Every decision is logged to `~/.agentwall/session-YYYY-MM-DD.jsonl`.

```bash
agentwall replay          # color-coded table of today's decisions
agentwall replay 20       # last 20 entries
```

The log is written independently of what the model claims it did. It is ground truth — every tool call that actually reached AgentWall, regardless of what the model reported.

---

## How it works

AgentWall is an MCP proxy. When your AI client starts an MCP server, it actually starts AgentWall, which starts the real server behind it. AgentWall forwards `tools/list` unchanged so the client sees the real tools. On `tools/call`, AgentWall evaluates the call against your policy before forwarding.

```
Client  ←→  AgentWall Proxy  ←→  Real MCP Server
                  |
            policy.yaml
            audit log
            approval UI
```

The client never knows AgentWall is there. The real server never knows it is being proxied.

Your `claude_desktop_config.json` changes from:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~"]
    }
  }
}
```

To:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "agentwall",
      "args": ["proxy", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "~"]
    }
  }
}
```

`agentwall setup` makes this change automatically for every configured server.

---

## What AgentWall protects against

- Accidental destruction — `rm -rf`, `DROP TABLE`, `TRUNCATE`
- Credential access — `~/.ssh`, `~/.aws`, `~/.gnupg`
- Shell config modification — `~/.bashrc`, `~/.zshrc` (persistence/backdoor)
- Operations outside your workspace
- Destructive git operations — force push, push to main
- Runaway agents — rate limiting per tool per session
- Common obfuscation patterns — `eval`, `base64 -d`
- Database writes without approval — `DELETE`, `ALTER`, `UPDATE`

---

## What AgentWall does not protect against

**Obfuscated commands** — `eval $(echo cm0= | base64 -d)`. Pattern matching sees `eval`, not the decoded payload.

**Data exfiltration via request body** — AgentWall sees the `curl` command, not the network payload.

**Prompt injection** — Would require scanning every file before the agent reads it.

**Multi-step attacks** — Each tool call is evaluated independently. Reading credentials and curling them out crosses two separate calls.

AgentWall is a policy engine, not a security sandbox. The right complement is OS-level isolation — run your agent in a container with no credential access in the first place. AgentWall and OS isolation are complementary, not alternatives.

---

## Version history

| Version | Theme | What shipped |
|---|---|---|
| v0.1 | Proof of concept | exec interception, YAML policy engine, JSONL audit log |
| v0.2 | Full OpenClaw coverage | Native plugin, all tool calls intercepted |
| v0.3 | Runtime agnostic | MCP proxy — Claude Desktop, Cursor, Windsurf |
| v0.4 | Zero friction | `agentwall setup`, database rules, npm publish |
| v0.5 | Usability | Hot-reload, rate limiting |
| v0.6 | Web UI | Approval page, policy editor, log viewer |
| v0.7 | Client visibility | Clients tab, auto-detection, one-click protect |
| v0.8 | Notifications | macOS notification, tab title, sound |

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
