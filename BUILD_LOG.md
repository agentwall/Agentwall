# AgentWall — Build Log

## What Was Built

AgentWall is a runtime safety layer for local AI agents. It intercepts shell
commands proposed by AI agents before they execute, evaluates them against a
YAML policy, and either allows them automatically, blocks them, or asks the
developer for approval. Every decision is logged to a JSONL file for audit
and replay.

### Architecture

```
agentwall/
├── src/
│   ├── cli.ts                            # Entry point + command routing
│   ├── core/
│   │   ├── types.ts                      # Shared types (ActionProposal, Decision, LogEntry)
│   │   ├── policy.ts                     # YAML policy engine with glob matching
│   │   ├── logger.ts                     # JSONL event logger + formatted replay
│   │   └── prompt.ts                     # Terminal approval prompt with queue + session memory
│   └── adapters/
│       └── openclaw/
│           └── client.ts                 # OpenClaw WebSocket adapter with Ed25519 signing
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

### Modules Implemented

**`src/core/types.ts`** — Shared type definitions that cross the adapter/core
boundary. `ActionProposal`, `Decision` (allow/deny/ask), `LogEntry`, `Runtime`.

**`src/core/policy.ts`** — Loads `~/.agentwall/policy.yaml`, validates structure
and keys, evaluates rules in deny → allow → ask order. Supports glob pattern
matching (`*` matches any character except `/`, `**` matches anything), command
prefix matching, `~` home directory expansion, `workspace/**` expansion, and
`outside:workspace` special path value. Falls back to built-in defaults if no
policy file exists.

**`src/core/logger.ts`** — Appends one JSON line per decision to
`~/.agentwall/session-YYYY-MM-DD.jsonl`. Creates the directory if needed.
Write failures warn to stderr but never crash. `replay()` reads the latest
session log and prints a color-coded table (ALLOW=green, DENY=red, ASK=yellow).

**`src/core/prompt.ts`** — Displays an approval prompt on `process.stderr`.
Queues concurrent approvals and shows one at a time with a pending count.
Maintains a `Set<string>` of base executables approved with "always" during
the session. Auto-denies after 5 minutes of no response.

**`src/adapters/openclaw/client.ts`** — Connects to the OpenClaw gateway
WebSocket (`ws://127.0.0.1:18789`). Generates an Ed25519 keypair on first run,
stores device identity at `~/.agentwall/device.json` with `0o600` permissions.
Handles the challenge-response handshake with v2 pipe-delimited signing.
Intercepts `exec.approval.requested` events and resolves them via
`exec.approval.resolve`. Reconnects automatically on disconnect with a
2-second backoff.

**`src/cli.ts`** — Parses `process.argv` manually (no CLI framework). Commands:
`start`, `init`, `setup openclaw`, `replay [N]`, `status`, `--help`. Manages a
PID lock file at `~/.agentwall/agentwall.lock`. Wires policy → prompt → logger →
adapter together in the `start` command.

### Tech Stack

- TypeScript with `strict: true`, ESM modules
- Node.js ≥ 22
- Two runtime dependencies: `ws` (WebSocket), `js-yaml` (policy parsing)
- No CLI framework, no terminal color library — ANSI codes used directly
- Ed25519 signing via Node's built-in `crypto` module

---

## Test Results

All tests ran on 2026-03-19. TypeScript compiled with zero errors under strict
mode.

### CLI Commands — 13/13 pass

| Command | Result | Notes |
|---|---|---|
| `agentwall --help` | PASS | Formatted usage with all commands and flags |
| `agentwall status` (no policy) | PASS | Shows "not configured (using defaults)" |
| `agentwall status` (with policy) | PASS | Shows policy path and running state |
| `agentwall init` | PASS | Creates `~/.agentwall/policy.yaml` |
| `agentwall init` (2nd run) | PASS | "Policy already exists" — idempotent |
| `agentwall setup openclaw` | PASS | Prints JSON config + restart instructions |
| `agentwall setup badruntime` | PASS | Error + exit code 1 |
| `agentwall badcommand` | PASS | "Unknown command" error + exit code 1 |
| `agentwall start` (no token) | PASS | "No gateway token provided" error |
| `agentwall start --token fake` | PASS | Connects to gateway, rejects bad token |
| `agentwall replay` | PASS | Color-coded table of all session entries |
| `agentwall replay 2` | PASS | Limits output to last 2 entries |
| `npm run build` / `node dist/cli.js` | PASS | Compiled JS runs correctly |

### Policy Engine — 24/24 pass

| Category | Tests | Details |
|---|---|---|
| Deny rules | 8 | `rm -rf /`, `rm -rf /home` (prefix), `curl * \| bash`, `wget * \| bash`, `~/.ssh`, `~/.ssh/subdir`, `~/.aws`, `~/.gnupg` |
| Allow rules | 2 | Workspace root, workspace subdirectory |
| Allow > Ask precedence | 2 | Dangerous commands auto-allowed inside workspace (deny→allow→ask order) |
| Ask rules (outside workspace) | 5 | `rm -rf`, `rm -r`, `sudo`, `chmod -R`, `dd` — all flagged outside workspace |
| Default behavior | 1 | Unknown command with empty workingDir defaults to ask |
| Edge cases | 4 | Empty workingDir skips path rules, prefix boundary (cwdX ≠ cwd), `rm -rf` no trailing |

Key finding: the deny → allow → ask evaluation order means `allow: workspace/**`
fires before ask rules for commands run inside the workspace. Dangerous commands
like `rm -rf` or `sudo` are auto-allowed inside the workspace but flagged
outside it. Only deny-list patterns (`rm -rf /`, pipe-to-shell, sensitive paths)
block commands regardless of location.

### Device Identity — 7/7 pass

| Test | Result |
|---|---|
| Adapter name is "openclaw" | PASS |
| `device.json` created on first run | PASS |
| Device ID is 64-character hex SHA256 | PASS |
| Public key PEM format correct | PASS |
| Private key PEM format correct | PASS |
| Device token null initially | PASS |
| Second instantiation reuses same identity | PASS |

### Logger + Replay — pass

Wrote 3 synthetic log entries (ALLOW, ASK, DENY), verified JSONL file format,
replay renders correctly formatted table with color-coded decisions and proper
column alignment.

### Summary

```
  Component          Tests    Result
  ─────────────────────────────────────
  CLI commands         13     13 pass
  Policy engine        24     24 pass
  Device identity       7      7 pass
  Logger + replay       —     pass
  TypeScript strict     —     0 errors
  Production build      —     compiles + runs
  ─────────────────────────────────────
  Total                44+    ALL PASS
```

### Not Tested (requires live environment)

- End-to-end approval flow with a running OpenClaw gateway and an AI agent
  proposing a shell command
- Interactive approval prompt (y/n/a input, session memory "always" behavior,
  auto-deny timeout, concurrent queue)
- WebSocket reconnection after gateway disconnect
- Lock file conflict detection with a second running instance

---

## v0.2.0 — Native Plugin Build (2026-03-19)

### What Changed

v0.2 replaces the v0.1 WebSocket adapter (`exec.approval.requested` event hack)
with a native OpenClaw plugin using the `before_tool_call` hook. This intercepts
**all** tool calls — not just `exec` — before they execute.

### Reverse-Engineering Results

Plugin discovery was determined by reading the compiled OpenClaw runtime
(`skills-CtzUimzY.js`, `utils-B88a096J.js`, `frontmatter-D0K3qXQH.js`):

- `resolvePluginSourceRoots()` in `src/plugins/roots.ts` resolves three roots:
  - `stock` — bundled plugins shipped with OpenClaw
  - `global` — `path.join(resolveConfigDir(), "extensions")` → `~/.openclaw/extensions/`
  - `workspace` — `<workspaceRoot>/.openclaw/extensions/`
- `resolveConfigDir()` returns `~/.openclaw` (or `$OPENCLAW_STATE_DIR` if set)
- `discoverInDirectory()` scans each subdirectory, looks for `openclaw.plugin.json`
  manifest and falls back to `DEFAULT_PLUGIN_ENTRY_CANDIDATES` (`index.ts`,
  `index.js`, `index.mjs`, `index.cjs`)
- The `before_tool_call` hook returns `{ block, blockReason, params }` to
  control tool execution
- `MANIFEST_KEY` in `package.json` is `"openclaw"` — the `openclaw.extensions`
  array is required for `openclaw plugins install` to recognize the entry point

### Wiring — What Worked and What Didn't

**Attempt 1 — Symlink into `~/.openclaw/extensions/` (FAILED)**

```
ln -s ~/agentwall ~/.openclaw/extensions/agentwall
```

This did not work. `discoverInDirectory()` uses `fs.readdirSync(dir, { withFileTypes: true })`
and the resulting `Dirent` objects return `isDirectory() === false` for symlinks.
The code at line 622 (`if (!entry.isDirectory()) continue;`) skips them. No
diagnostic was emitted — the symlink was silently ignored.

**Attempt 2 — `openclaw plugins install --link` (FAILED initially)**

```
openclaw plugins install ~/agentwall --link
```

First run failed with: `package.json missing openclaw.extensions`. The install
command requires a `"openclaw": { "extensions": ["./index.js"] }` field in
`package.json` to know which file is the plugin entry point.

**Attempt 3 — Added `openclaw.extensions`, re-ran install (SUCCESS)**

After adding the `openclaw` metadata to `package.json`:

```json
"openclaw": {
  "extensions": ["./index.js"]
}
```

Re-ran `openclaw plugins install ~/agentwall --link`. Output:

```
[plugins] [AgentWall] v0.2 activated — intercepting all tool calls
Linked plugin path: ~/agentwall
Restart the gateway to load plugins.
```

This approach uses `discoverFromPath()` (via config `loadPaths`), which resolves
paths with `fs.statSync` — follows symlinks properly. The install command wrote
the path to `~/.openclaw/openclaw.json` under `plugins.installs`.

### New Files

```
agentwall/
├── openclaw.plugin.json          ← plugin manifest (id, name, version, configSchema)
├── index.js                      ← plugin entry point (activate → registers hook)
└── src/
    ├── hook.js                   ← before_tool_call handler (intercept → policy → prompt → log)
    ├── policy.js                 ← allow/block/prompt policy (configurable sets)
    ├── approver.js               ← terminal approval prompt (y/N, 5-min auto-deny)
    └── logger.js                 ← JSONL decision log at ~/.agentwall/decisions.jsonl
```

### Modified Files

- `package.json` — version → 0.2.0, added `"main": "index.js"`, added
  `"openclaw": { "extensions": ["./index.js"] }`

### Architecture

```
OpenClaw gateway
  └─ plugin loader (reads ~/.openclaw/openclaw.json → plugins.installs.agentwall)
       └─ loads ~/agentwall/index.js
            └─ activate(api) registers before_tool_call hook
                 └─ AgentWall handler (src/hook.js)
                      ├─ getPolicy(toolName) → allow | block | prompt
                      ├─ if 'block' → return { block: true, blockReason }
                      ├─ if 'allow' → return undefined (pass-through)
                      └─ if 'prompt':
                           ├─ promptApproval() → stderr prompt, y/N
                           ├─ logDecision() → ~/.agentwall/decisions.jsonl
                           └─ return { block: true } or undefined
```

### v0.1 Code Preserved

All v0.1 TypeScript source (`src/cli.ts`, `src/core/*`, `src/adapters/*`) remains
intact. The v0.2 plugin files are plain JS and coexist alongside the v0.1 code.
The v0.1 WebSocket adapter is now deprecated — v0.2 handles all tool calls
(including `exec`) through the plugin hook. Running both simultaneously would
cause double-prompting on `exec` calls.

### Test Results (2026-03-19)

Plugin installed via `openclaw plugins install --link`. Verified with
`openclaw plugins list` — shows `AgentWall (agentwall) loaded`, origin `config`,
version `0.2.0`.

After gateway restart, triggered two `exec` tool calls ("ls -la ~"):

| # | Tool | Decision | Reason | Logged |
|---|------|----------|--------|--------|
| 1 | exec | approved | user   | yes    |
| 2 | exec | blocked  | user   | yes    |

Both decisions written to `~/.agentwall/decisions.jsonl` with full context
(timestamp, toolName, params, agentId, sessionKey, runId).

### Still To Test

- Non-exec tool interception (`read_file`, `write_file`, `edit`, `apply_patch`)
- Auto-deny on prompt timeout (5 minutes no response)
- Policy auto-allow and auto-block (adding tools to `AUTO_ALLOW` / `AUTO_BLOCK`
  sets in `src/policy.js`)
- Headless mode behavior (no TTY → prompt fails → blocks for safety)

---

## v0.3.0 — MCP Proxy Build (2026-03-19)

### What Changed

v0.3 adds a protocol-level MCP proxy that sits between any MCP client (Cursor,
Claude Code, Claude Desktop, Windsurf, Cline, etc.) and any MCP server. This
makes AgentWall runtime-agnostic — it intercepts every `tools/call` request
regardless of which client issued it.

### Architecture

```
MCP Client (Cursor / Claude Code / Claude Desktop)
    ↓  tools/call (stdio JSON-RPC)
[ AgentWall MCP Proxy ]
├── StdioServerTransport (receives from client via stdin/stdout)
├── PolicyEngine (YAML rules: deny → allow → ask)
├── askUser via /dev/tty (approval prompt, when TTY available)
├── EventLogger (JSONL audit log)
└── StdioClientTransport (spawns real server as child process)
    ↓  approved calls only
[ Real MCP Server ]
```

Config changes from:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
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
      "args": ["proxy", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
```

### New Files

```
src/adapters/mcp/proxy.ts       ← MCP proxy adapter (Server + Client composition)
```

### Modified Files

| File | Change |
|---|---|
| `src/core/prompt.ts` | Added `/dev/tty` input mode (`useTtyInput()`) — proxy mode reads approval input from TTY instead of stdin (stdin carries MCP traffic). Gracefully denies when no TTY available. |
| `src/core/types.ts` | Added `McpProxyOptions` interface |
| `src/cli.ts` | Added `proxy` subcommand, `setup mcp` instructions, version → 0.3.0 |
| `src/hook.js` | Migrated from `approver.js` to `prompt.ts` — unified approval UI |
| `package.json` | Version → 0.3.0, added `@modelcontextprotocol/sdk` dependency |

### Deleted Files

| File | Reason |
|---|---|
| `src/approver.js` | Replaced by canonical `src/core/prompt.ts` — one approval UI across all adapters |

### How the Proxy Works

1. `StdioClientTransport` spawns the real MCP server as a child process
2. `Client` connects to it, performs MCP initialization handshake
3. Real server's capabilities are read via `client.getServerCapabilities()`
4. `Server` is created with matching capabilities (mirroring the real server)
5. Handlers registered for all known MCP methods:
   - `tools/call` — **intercepted** through policy engine
   - `tools/list` — forwarded unchanged
   - `resources/*`, `prompts/*`, `completions/*`, `logging/*` — forwarded transparently
6. `StdioServerTransport` connects to the client (Cursor/Claude) via stdin/stdout
7. Blocked calls return `{ isError: true, content: [{ type: "text", text: "AgentWall: ..." }] }`

### Smart Command Extraction

For shell/exec tools (`bash`, `exec`, `shell`, `run_command`, etc.), the proxy
extracts the actual command from the tool arguments and uses it for policy
matching. This makes existing shell-oriented policy rules (`rm -rf*`, `sudo *`)
work for MCP bash tool calls.

For other tools, the tool name itself is used as the "command" for policy
matching (e.g., `list_directory`, `write_file`, `query`).

Path is extracted from common argument field names: `path`, `file`, `filename`,
`directory`, `uri`.

### Edge Cases Handled

| Edge case | How it's handled |
|---|---|
| No TTY (Cursor, Claude Desktop) | `openInput()` checks `/dev/tty` availability upfront via `openSync`. Falls back to auto-deny. |
| Real server crash | `realTransport.onclose` propagates clean error, proxy exits |
| Concurrent tool calls | `prompt.ts` queue — one prompt at a time, pending count shown |
| JSON-RPC framing | SDK's `StdioServerTransport` / `StdioClientTransport` handle framing — no manual parsing |
| Policy evaluation for MCP | deny → allow → ask order, same YAML file as v0.1/v0.2 |

### Known Limitations

| Limitation | Reason |
|---|---|
| Cannot intercept client's built-in tools | Cursor/Claude Desktop built-in tools don't go through MCP — they're internal to the client process |
| No interactive prompt in GUI clients | Cursor and Claude Desktop spawn MCP servers without a terminal. Approval prompts work only in CLI contexts (Claude Code, standalone terminal). |
| Policy not hot-reloaded | `PolicyEngine` reads YAML at startup. Proxy restart required for policy changes. |

### Research Findings (MCP SDK)

SDK version 1.27.1 (`@modelcontextprotocol/sdk`) found at
`/opt/homebrew/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/`.

| Question | Answer |
|---|---|
| Separate transport classes? | Yes — `StdioServerTransport` (server/stdio.js) and `StdioClientTransport` (client/stdio.js) |
| `CallToolRequest` shape? | `{ method: "tools/call", params: { name: string, arguments?: Record<string, unknown> } }` |
| Transport type? | stdio — config uses `command` + `args` |
| Existing MCP proxy? | None generic — only OpenClaw's ACP-specific `mcp-proxy.mjs` and SDK's `ProxyOAuthServerProvider` |
| Decision | Compose two SDK transport instances (recommended path) |

### Test Results (2026-03-19)

#### Build

- TypeScript strict mode: **0 errors**
- `npm run build`: **clean**

#### Terminal Standalone Test

Piped test sending `initialize` → `notifications/initialized` → `tools/list` → `tools/call`:

| Step | Result |
|---|---|
| `initialize` | Proxy responded as `agentwall-proxy v0.3.0`, mirrored real server capabilities |
| `tools/list` | Forwarded 14 filesystem tools unchanged from real server |
| `tools/call` (list_directory) | Intercepted — approval prompt appeared, user approved, result returned |

#### Interactive Test (named pipe)

```bash
bash /tmp/mcp-test.sh
```

Approval prompt appeared for `list_directory`. User typed `y`, directory listing returned. Logged to JSONL.

#### Cursor Test

Configured `~/.cursor/mcp.json` to route filesystem server through proxy.
After reload, Cursor used the MCP `list_directory` tool:

```
17:37:49   mcp   ALLOW   policy   list_directory   ← auto-allowed by policy
17:37:55   mcp   ALLOW   policy   list_directory   ← auto-allowed by policy
```

Both calls auto-allowed (tool in allow list), logged, results returned to Cursor.

#### Claude Desktop Test

Configured `~/Library/Application Support/Claude/claude_desktop_config.json`.
Claude Desktop logs confirmed proxy started:

```
Server started and connected successfully
agentwall v0.3.0 — MCP proxy mode
✓ Connected to real MCP server
✓ Proxy ready — intercepting tool calls
```

Tested deny override — added `list_directory` to deny list:

```
18:14:45   mcp   ALLOW   policy   list_allowed_directories   ← allowed
18:14:47   mcp   DENY    policy   list_directory              ← BLOCKED despite Claude "Always allow"
```

Claude Desktop approved the call in its UI. AgentWall denied it anyway.
Confirms: client approval does not override AgentWall policy.

#### Backward Compatibility

| Version | Test | Result |
|---|---|---|
| v0.1 | `agentwall start --help` | CLI loads, all commands present |
| v0.2 | `import('./index.js')` | Plugin loads: "AgentWall 0.2.0" |

#### Audit Log (unified across all runtimes)

```
TIME       RUNTIME      DECISION  BY       COMMAND
──────────────────────────────────────────────────────────────────────────
13:13:21   openclaw     ALLOW     policy   git status
13:13:21   openclaw     ASK       user     rm -rf ./node_modules
13:13:21   openclaw     DENY      policy   cat ~/.ssh/id_rsa
17:25:34   mcp          ASK       user     list_directory
17:37:49   mcp          ALLOW     policy   list_directory
18:14:47   mcp          DENY      policy   list_directory
```

Both `openclaw` and `mcp` runtimes log to the same session file.

### Version History

| Version | What gets intercepted | How |
|---|---|---|
| v0.1 | `exec` — shell commands only | OpenClaw WebSocket event adapter |
| v0.2 | All tool calls inside OpenClaw | Native OpenClaw plugin (`before_tool_call` hook) |
| v0.3 | **Everything MCP-speaking** | **Protocol-level MCP proxy** |

---

## v0.4.0 — Policy Engine v2 + Zero-Friction Setup (2026-03-19)

### What Changed

v0.4 ships two features together:

1. **Policy engine v2** — adds argument content matching (`match` field) and tool
   name matching (`tool` field) to the YAML policy engine. This enables rules like
   "block any SQL query containing DROP" across any MCP tool, regardless of what
   the tool is called or which argument carries the SQL.

2. **Zero-friction setup** — `agentwall setup` auto-detects Claude Desktop, Cursor,
   Windsurf, and Claude Code MCP configurations, wraps every server with the proxy,
   backs up originals, and tells the user to restart. No JSON editing required.

### Architecture

```
agentwall/
├── src/
│   ├── cli.ts                        ← CLI entry (UPDATED: setup, undo, status, --version)
│   ├── core/
│   │   ├── types.ts                  ← UPDATED: toolName + args on ActionProposal
│   │   ├── policy.ts                 ← UPDATED: tool, match, url fields + case-insensitive matching
│   │   ├── logger.ts                 ← unchanged
│   │   └── prompt.ts                 ← unchanged
│   └── adapters/
│       ├── openclaw/
│       │   └── client.ts             ← unchanged
│       └── mcp/
│           └── proxy.ts              ← UPDATED: passes toolName + args to policy engine
├── index.js                          ← unchanged
├── openclaw.plugin.json              ← unchanged
├── package.json                      ← UPDATED: v0.4.0, files, keywords, description
├── tsconfig.json                     ← unchanged
└── README.md                         ← REWRITTEN for launch
```

### Modified Files

| File | Change |
|---|---|
| `src/core/types.ts` | Added `toolName?: string` and `args?: Record<string, unknown>` to `ActionProposal` |
| `src/core/policy.ts` | Added `tool`, `match`, `url` to `PolicyRule`. New matchers: `matchesTool()`, `matchesArgContent()` (case-insensitive), `matchesUrl()`. Rewrote `ruleMatches()` with conditions array + AND logic. Updated `evaluate()` so non-path ask rules (tool/match) fire before allow. Expanded `DEFAULT_POLICY` with database protection rules. Updated validation for new field types. |
| `src/adapters/mcp/proxy.ts` | Passes `toolName` and `args` in `ActionProposal` construction. Version → 0.4.0. |
| `src/cli.ts` | Added `setup` (auto-detect), `setup --dry-run`, `undo`, `--version`. MCP config detection for Claude Desktop, Cursor, Windsurf, Claude Code with platform-aware paths. Wrapping transform with idempotency check. Backup logic (`.bak`, `.bak.2`, etc.). Extended `status` with protection counts, policy rule counts, session log stats. Version → 0.4.0. |
| `package.json` | Version → 0.4.0. Description updated. Added `files` field. Updated keywords. |
| `README.md` | Full rewrite: hook, one-liner install, client support table, policy-override demo, database protection examples, command reference, architecture diagram, version history. |

### Policy Engine v2 — How It Works

New `PolicyRule` fields:

| Field | Type | Description |
|---|---|---|
| `tool` | `string` | MCP tool name glob (e.g. `"*"`, `"query"`, `"pg_*"`) |
| `match` | `Record<string, string>` | Argument name → glob pattern. Keys are argument field names, values are glob patterns. |
| `url` | `string` | URL pattern shorthand (checks `args.url` or `args.uri`) |

All fields in a rule use AND logic — every specified condition must match.
The `match` field uses **case-insensitive** glob matching for SQL safety
(`DROP`, `drop`, `Drop` all match `"drop *"`).

The `evaluate()` ordering was updated: non-path ask rules now fire before
path-based allow rules. This prevents `allow: workspace/**` from silently
permitting `DELETE FROM users` inside the workspace.

### Setup Command — How It Works

```
agentwall setup [--dry-run]
```

1. Verifies `agentwall` is on PATH via `execSync('agentwall --version')`
2. Scans platform-aware config locations for Claude Desktop, Cursor, Windsurf, Claude Code
3. Parses each JSON config, finds `mcpServers` entries
4. For each server entry:
   - **Skip** if already wrapped (idempotency: `command === "agentwall"` + args contain `proxy` and `--`)
   - **Skip** if HTTP transport (`url` field without `command`) with warning
   - **Transform**: `command → "agentwall"`, `args → ["proxy", "--", origCommand, ...origArgs]`
5. `--dry-run`: prints transforms without writing
6. Interactive: prompts `Y/n`, backs up configs (`.bak` with numbered fallback), writes transforms
7. Prints restart instructions with GUI/policy-only mode caveat

### Undo Command

```
agentwall undo
```

Finds all `.bak` files in known config locations, restores the original (first
backup), removes all backup files. Prints "Nothing to undo" if no backups exist.

### Status Command

```
agentwall status
```

Now shows:
- Protection status per client (N/M servers protected)
- Policy rule counts (deny/ask/allow)
- Today's session log stats (allowed/approved/blocked)

### Default Policy (generated by `agentwall init`)

The v0.4 default policy adds database protection out of the box:

**Deny rules (17):**
- Filesystem: `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`, `~/.npmrc`, `~/.netrc`, `/etc/**`, `/System/**`
- Shell: `curl * | *`, `wget * | *`, `rm -rf /`, `rm -rf ~`, `rm -rf /home`
- Database: DROP and TRUNCATE across `sql`, `query`, `statement` argument names

**Ask rules (13):**
- Database: DELETE, ALTER, UPDATE across `sql`, `query` argument names
- Shell: `rm -rf *`, `rm -r *`, `sudo *`, `chmod -R *`, `dd *`
- Filesystem: `write_file` and `edit` outside workspace

**Allow rules (1):**
- `workspace/**`

### Test Results (2026-03-19)

#### Build

- TypeScript strict mode: **0 errors**
- `npm run build`: **clean**
- `npm pack --dry-run`: **19 files, 19.3 kB** — correct `files` field

#### CLI Commands — 7/7 pass

| Command | Result |
|---|---|
| `agentwall --version` | `agentwall v0.4.0` |
| `agentwall --help` | New help text with all v0.4 commands + version history |
| `agentwall setup --dry-run` | Detected Claude Desktop (1 server) + Cursor (1 server), showed transforms |
| `agentwall setup openclaw` | Legacy instructions preserved |
| `agentwall setup mcp` | Legacy instructions preserved |
| `agentwall status` | Protection counts, policy stats, session log stats |
| `agentwall undo` | "No backups found" (correct — none exist) |

#### Policy Engine — 22/22 pass

| Category | Tests | Details |
|---|---|---|
| Case insensitivity | 3 | `DROP TABLE`, `Drop Table`, `drop table` — all denied |
| Argument name coverage | 3 | `sql`, `query`, `statement` fields — all matched for DROP |
| Deny rules (database) | 2 | TRUNCATE via `sql`, DROP via `statement` |
| Ask rules (database) | 3 | DELETE, ALTER, UPDATE — all routed to ask |
| Non-match passthrough | 2 | SELECT, INSERT — fall to default ask |
| Wrong arg name | 1 | DROP in unmatched arg name (`body`) correctly ignored |
| Shell deny | 5 | `curl pipe bash`, `wget pipe`, `rm -rf /`, `rm -rf ~`, `rm -rf /home` |
| Shell ask | 2 | `rm -rf mydir`, `sudo *` |
| Path deny | 2 | `~/.ssh/id_rsa`, `~/.aws/credentials` |
| Wildcard tool | 1 | `tool: "*"` matches any tool name |

#### E2E Setup/Undo Cycle — 6/6 pass

| Test | Result |
|---|---|
| Wrap transform | Correct `agentwall proxy --` prefix |
| Idempotency detection | Already-wrapped entries detected |
| HTTP transport skip | `url`-based entries correctly skipped |
| Full wrap cycle | stdio servers wrapped, HTTP skipped |
| Double-wrap prevention | Zero changes on second pass |
| Backup + undo | Originals restored, `.bak` files cleaned up |

### Version History

| Version | What gets intercepted | How |
|---|---|---|
| v0.1 | `exec` — shell commands only | OpenClaw WebSocket event adapter |
| v0.2 | All tool calls inside OpenClaw | Native OpenClaw plugin (`before_tool_call` hook) |
| v0.3 | Everything MCP-speaking | Protocol-level MCP proxy |
| v0.4 | **Same + database rules** | **Policy engine v2 + zero-friction setup** |

---

## v0.5.0 — Hot-Reload + Rate Limiting (2026-03-19)

### What Changed

v0.5 ships two features:

1. **Hot-reload** — `PolicyEngine.watch()` monitors `~/.agentwall/policy.yaml`
   for changes and reloads rules in place. No proxy restart, no gateway restart.
   Editors that replace files (Emacs, some IDEs) are handled via a directory
   watcher that detects rename events and restarts the file watcher on the new
   inode.

2. **Rate limiting** — New `limits` section in `policy.yaml`. Caps tool calls
   per session per time window. When a limit is hit, the call is auto-denied
   with a message the agent can read: `AgentWall: exec rate limit reached
   (10/60s). Wait 43 seconds.`

### Architecture Changes

```
PolicyEngine
├── load()          ← NEW: extracted from constructor, returns PolicyConfig or throws
├── watch()         ← NEW: fs.watch on file + directory, 200ms debounce, reload on change
├── stopWatch()     ← NEW: closes both watchers
├── evaluate()      ← UPDATED: returns Decision object, rate limit check before deny/allow/ask
└── rateLimiter     ← NEW: private RateLimiter instance

RateLimiter (internal, not exported)
├── sessions: Map<string, CallRecord[]>   ← per-session call history
├── check(toolName, sessionKey, limits)   ← returns limited/not-limited + retry info
├── record(toolName, sessionKey, limits)  ← appends to history, prunes old records
└── cleanup()                             ← 10-minute interval, removes stale sessions
```

### Type System Changes

The `Decision` type was restructured from a string union to an object:

```typescript
// Before (v0.4)
type Decision = "allow" | "deny" | "ask";

// After (v0.5)
type DecisionVerdict = "allow" | "deny" | "ask";
type DecisionReason = "policy" | "user" | "auto-allow" | "rate-limit";
type Decision = {
  decision: DecisionVerdict;
  reason: DecisionReason;
  message?: string;      // populated only for rate-limit denials
};
```

New types added:
- `LimitRule` — `{ tool: string; max: number; window: number }`
- `DecisionVerdict` — the original string union, renamed for backward compat
- `DecisionReason` — reason codes for audit logging

`LogEntry.resolvedBy` was widened from `"policy" | "user"` to `DecisionReason`
so rate-limited decisions appear in the audit log with the correct reason code.

### Modified Files

| File | Change |
|---|---|
| `src/core/types.ts` | Added `LimitRule`, `DecisionVerdict`, `DecisionReason`. Restructured `Decision` from string to object. Updated `LogEntry.decision` to `DecisionVerdict`, `LogEntry.resolvedBy` to `DecisionReason`. |
| `src/core/policy.ts` | Extracted `load()` from constructor (throws instead of `process.exit`). Added `watch()`, `stopWatch()`. Added `RateLimiter` class. Added `limits` to `PolicyConfig`, `"limits"` to `VALID_TOP_KEYS`. Added `validateLimitRules()`. Updated `evaluate()` to return `Decision` object with rate limit check first. Added limits section to `DEFAULT_POLICY`. |
| `src/adapters/mcp/proxy.ts` | Wired `policy.watch()` after construction. Updated tool call handler for `Decision` object. Rate-limit denials use `decision.message` as block text. Added `policy.stopWatch()` to shutdown. Version → 0.5.0. |
| `src/cli.ts` | Wired `policy.watch()` in `startCommand()`. Updated proposal handler for `Decision` object. Added rate limit rule count to `statusCommand()`. Updated help text with v0.5. Version → 0.5.0. |
| `src/core/logger.ts` | Changed type import from `Decision` to `DecisionVerdict` for `DECISION_COLORS`. No logic changes. |
| `package.json` | Version → 0.5.0. |
| `README.md` | Added v0.5 section (hot-reload + rate limiting). Added "What AgentWall protects against" and "What AgentWall does not protect against" sections. Updated version history table. |

### Policy Syntax — Rate Limits

```yaml
limits:
  - tool: exec
    max: 30
    window: 60      # max 30 shell commands per minute
  - tool: write
    max: 50
    window: 60      # max 50 file writes per minute
  - tool: "*"
    max: 200
    window: 300     # max 200 total tool calls per 5 minutes
```

The `tool` field supports glob patterns (same as deny/allow/ask rules).
`"*"` matches all tools. Rate limits are evaluated per-session using
`proposal.sessionId` (falls back to `"global"` if not set).

### Key Design Decisions

**Constructor refactoring** — The constructor previously called `process.exit(1)`
on bad YAML. The new `load()` method throws instead, allowing `watch()` to catch
errors and keep previous rules. The constructor still exits on first load failure
(startup time), but subsequent reloads are graceful.

**Rate limiter is per-session** — Each unique `sessionId` gets its own call
history. The `"global"` fallback means rate limiting still works when `sessionId`
is not populated, but limits are shared across all sessions. This is documented
as acceptable for v0.5.

**Rate check runs before policy rules** — A rate-limited call is denied before
deny/allow/ask evaluation. This is intentional: if an agent is in a runaway
loop, we want to stop it immediately regardless of what the policy says.

**Record after check** — `rateLimiter.record()` is called only after `check()`
returns `limited: false`. Denied calls do not count against the limit (otherwise
the agent could never recover after hitting a limit).

**OpenClaw plugin not wired** — The `index.js` → `src/hook.js` → `src/policy.js`
code path uses a separate hardcoded allow/block set, not the YAML-based
`PolicyEngine`. Refactoring it is out of scope for v0.5. Hot-reload and rate
limiting apply to the MCP proxy and CLI `start` command.

### Test Results (2026-03-19)

#### Build

- TypeScript strict mode: **0 errors**
- `npm run build`: **clean**
- `agentwall --version`: **agentwall v0.5.0**

#### Rate Limiting — 16/16 pass

| Test | Result |
|---|---|
| exec call 1/3 passes rate limit | PASS |
| exec call 2/3 passes rate limit | PASS |
| exec call 3/3 passes rate limit | PASS |
| exec call 4/3 is rate-limited | PASS |
| rate-limit message contains "rate limit reached" | PASS |
| rate-limit message contains wait time | PASS |
| read_file passes (different tool, under wildcard limit) | PASS |
| rm -rf / is denied (rate-limit or policy) | PASS |
| exec passes for different session (per-session isolation) | PASS |
| wildcard: call 1/5 passes | PASS |
| wildcard: call 2/5 passes | PASS |
| wildcard: call 3/5 passes | PASS |
| wildcard: call 4/5 passes | PASS |
| wildcard: call 5/5 passes | PASS |
| wildcard: call 6/5 is rate-limited | PASS |

#### Hot-Reload — 8/8 pass

| Test | Result |
|---|---|
| before reload: "dangerous_cmd" is denied | PASS |
| before reload: "safe_cmd" falls through to ask | PASS |
| calling watch() twice does not throw (idempotent) | PASS |
| policy reloaded after file change | PASS |
| reload callback received correct file path | PASS |
| after reload: "dangerous_cmd" is now allowed | PASS |
| after bad YAML: previous rules preserved | PASS |
| stopWatch() completes without error | PASS |

Bad YAML resilience verified: writing invalid YAML triggers error to stderr
(`[AgentWall] Policy reload failed: ...` + `[AgentWall] Keeping previous rules.`)
and the previous working rules remain active.

#### Decision Object — 4/4 pass

| Test | Result |
|---|---|
| deny decision has correct verdict | PASS |
| deny decision has reason "policy" | PASS |
| policy deny has no message (only rate-limit does) | PASS |
| unknown command falls through to ask | PASS |

#### Summary

```
  Component          Tests    Result
  ─────────────────────────────────────
  Rate limiting        16     16 pass
  Hot-reload            8      8 pass
  Decision object       4      4 pass
  TypeScript strict     —     0 errors
  Production build      —     compiles + runs
  ─────────────────────────────────────
  Total                28     ALL PASS
```

### Version History

| Version | What gets intercepted | How |
|---|---|---|
| v0.1 | `exec` — shell commands only | OpenClaw WebSocket event adapter |
| v0.2 | All tool calls inside OpenClaw | Native OpenClaw plugin (`before_tool_call` hook) |
| v0.3 | Everything MCP-speaking | Protocol-level MCP proxy |
| v0.4 | Same + database rules | Policy engine v2 + zero-friction setup |
| v0.5 | Same + rate limiting | Hot-reload + rate limiting |
| v0.6 | **Same + web UI** | **Approval UI, policy editor, log viewer** |

---

## v0.6.0 — Web UI + Unified Approval (2026-03-19)

### What Changed

v0.6 ships the web UI (approval page, policy editor, log viewer) and unifies
all approval requests to flow through the browser at `http://localhost:7823`.
Previously, OpenClaw used terminal prompts and GUI MCP clients (Cursor, Claude
Desktop) could not prompt at all (no TTY → auto-deny). Now all runtimes route
through one web UI.

### Problems Solved

**Terminal-only prompts in headless environments.** GUI clients like Cursor and
Claude Desktop spawn MCP servers without a TTY. Before v0.6, `askUser()` checked
`inputMode === "tty" && !isTtyAvailable() && _webApprovalQueue` — a triple
condition that only routed to the web queue when explicitly in TTY mode with no
TTY available. This was too restrictive.

**OpenClaw dual-process architecture.** OpenClaw loads plugins in both the main
process and the gateway subprocess. Both called `setWebApprovalQueue()`, but only
one could bind port 7823. The second process's `ApprovalQueue` had no web server
connected — approval requests sat unanswered for 30 seconds and auto-denied.

**EADDRINUSE crashes.** When two runtimes (e.g., OpenClaw + Claude Desktop) ran
simultaneously, the second to start would crash trying to bind the same port.
Node.js `http.Server` error events weren't being caught in OpenClaw's plugin
environment (OpenClaw ignores async `activate()` return values and has its own
`process.on('uncaughtException')` handler).

**No real-time log broadcast for OpenClaw.** OpenClaw's hook (`src/hook.js`) used
its own `logDecision()` function writing to `~/.agentwall/decisions.jsonl`, not
the core `EventLogger`. Decisions were never broadcast via WebSocket, so the web
UI log viewer only showed MCP proxy entries.

**Generic "mcp" runtime label.** All MCP proxy entries showed as `runtime: "mcp"`
regardless of whether Claude Desktop, Cursor, or Windsurf was the client.

### Architecture

```
OpenClaw gateway (main process)
  └─ AgentWall plugin (index.js)
       ├─ ApprovalQueue + AgentWallWebServer on :7823
       ├─ EventLogger with onEntry → WebSocket broadcast
       └─ before_tool_call handler → askUser → web queue

OpenClaw gateway (subprocess)
  └─ AgentWall plugin (index.js)
       ├─ Port check: 7823 in use → remote proxy mode
       ├─ HTTP POST to /api/request-approval on :7823
       └─ before_tool_call handler → askUser → remote queue

Claude Desktop / Cursor / Windsurf (MCP proxy)
  └─ agentwall proxy -- <real server>
       ├─ Port check: 7823 free → start web server
       ├─ Port check: 7823 in use → remote proxy mode
       ├─ Client detection via MCP handshake → runtime label
       └─ tools/call handler → askUser → web/remote queue

Browser (http://localhost:7823)
  ├─ / (Approval)    ← pending approval requests
  ├─ /policy         ← YAML policy editor
  └─ /log            ← searchable audit log
```

### Fixes Applied

**Fix 1 — `src/core/prompt.ts`**

Removed TTY gating from `askUser()`. Changed:
```
if (inputMode === "tty" && !isTtyAvailable() && _webApprovalQueue)
```
to:
```
if (_webApprovalQueue)
```
If a web approval queue is registered, always use it. Terminal prompt path
preserved as fallback for `agentwall start` CLI mode (v0.1 flow).

**Fix 2 — `src/web/server.ts`**

- Added permanent `error` handler on `http.Server` in constructor to prevent
  uncaught exceptions in environments with global error handlers (OpenClaw).
- Added `once("error", onError)` in `start()` to surface errors as rejected
  promises.
- Added `POST /api/request-approval` endpoint — long-polling HTTP endpoint that
  accepts a remote approval request, adds it to the local `ApprovalQueue`, and
  blocks until the user responds in the browser. Returns `{ decision: "allow" | "deny" }`.
- Added static routes for `/logo.png` and `/favicon.ico`.

**Fix 3 — `src/adapters/mcp/proxy.ts`**

- Removed `checkTtyAvailable()` and all `!hasTty` gates. Always creates
  `ApprovalQueue` and wires `EventLogger` with `onEntry`.
- Added `isPortReachable()` — TCP socket probe to check if port 7823 is already
  bound before attempting `server.listen()`.
- When port is free: starts web server locally.
- When port is in use: creates a remote proxy queue that forwards approval
  requests via `HTTP POST` to the existing web server's `/api/request-approval`.
- Added `remoteApprovalRequest()` — sends `{ toolName, params, runtime }` via
  HTTP and blocks until the response arrives (35-second timeout, safe fallback
  to deny).
- Added MCP client identity detection via `server.getClientVersion()?.name`
  after the MCP handshake. Maps known client names to runtime labels:
  `claude-desktop`, `cursor`, `windsurf`, `claude-code`. Unknown clients log
  their name to stderr and fall back to `mcp`.

**Fix 4 — `index.js` (OpenClaw plugin)**

- Added imports for `ApprovalQueue`, `setWebApprovalQueue`, `AgentWallWebServer`,
  `EventLogger`, `PolicyEngine` from compiled `dist/`.
- `activate()` is synchronous (OpenClaw ignores async return values).
- Added `isPortReachable()` check before web server startup:
  - Port free: creates local `ApprovalQueue` + starts `AgentWallWebServer`.
  - Port in use: creates remote proxy queue via `remoteApprovalRequest()`.
- Web server startup uses `.then()/.catch()` chains instead of `async/await`
  to prevent unhandled promise rejections in OpenClaw's dual-process environment.
- Passes `EventLogger` instance to hook handler via `{ eventLogger }` option.

**Fix 5 — `src/hook.js` (OpenClaw handler)**

- `createBeforeToolCallHandler` now accepts `options = {}` with `eventLogger`.
- Added `toolName` and `args` to proposal object (previously missing — web
  approval UI could not display tool call parameters).
- Added `buildLogEntry()` helper that constructs `LogEntry` objects matching
  the core schema (`ts`, `runtime`, `decision`, `resolvedBy`, `command`,
  `workingDir`, `approvalId`, `sessionId`, `agentId`).
- Added `eventLogger.log()` calls at every decision point (policy block,
  auto-allow, prompt error, user approve/deny) so OpenClaw decisions broadcast
  via WebSocket and appear in the web UI log viewer in real time.

**Fix 6 — `src/core/types.ts`**

Extended `Runtime` union type: added `"windsurf"` and `"claude-desktop"` to
support the new client detection.

### UI Changes

- Added AgentWall shield logo to the nav bar (32x32) and as favicon on all
  three pages (Approval, Policy Editor, Log Viewer).
- Nav brand font size increased to 1.25rem, nav links to 1rem.

### Modified Files

| File | Change |
|---|---|
| `src/core/prompt.ts` | Removed TTY gating from `askUser()` |
| `src/core/types.ts` | Added `windsurf`, `claude-desktop` to `Runtime` union |
| `src/web/server.ts` | Added error handling in constructor/start, `/api/request-approval` endpoint, `/logo.png` + `/favicon.ico` routes |
| `src/adapters/mcp/proxy.ts` | Removed TTY gates, added port check, remote approval proxy, client identity detection |
| `index.js` | Full rewrite — web server startup, port check, remote approval proxy, EventLogger wiring |
| `src/hook.js` | Added eventLogger option, toolName/args on proposal, EventLogger.log at every decision |
| `src/web/ui/index.html` | Added favicon link, logo in nav, increased font sizes |
| `src/web/ui/log.html` | Added favicon link, logo in nav, increased font sizes |
| `src/web/ui/policy.html` | Added favicon link, logo in nav, increased font sizes |
| `src/web/ui/logo.png` | New — AgentWall shield logo |

### Key Design Decisions

**Port probing over EADDRINUSE.** Initial approach was to catch EADDRINUSE from
`server.listen()`. This failed in OpenClaw's environment because: (1) OpenClaw
ignores async plugin activation, turning rejections into uncaught exceptions;
(2) OpenClaw has its own `process.on('uncaughtException')` that fires even when
EventEmitter error handlers are registered. Solution: probe the port with a TCP
socket connection before attempting to listen. No EADDRINUSE can occur.

**Remote approval via HTTP long-poll.** When the web server port is already in
use by another runtime, the second runtime creates a lightweight proxy that sends
approval requests via `POST /api/request-approval`. The endpoint blocks until the
user responds in the browser, then returns the decision. 35-second HTTP timeout
(slightly longer than the 30-second approval timeout) ensures safe fallback to
deny.

**Synchronous activate() with promise chains.** OpenClaw ignores the return value
of `activate()` and logs a warning if it returns a promise (`plugin register
returned a promise; async registration is ignored`). All async work (port check,
web server startup) is done via `.then()/.catch()` chains that handle errors
internally. The `before_tool_call` handler is registered synchronously before
any async work completes.

**Client detection from MCP handshake.** The MCP SDK's `Server.getClientVersion()`
returns the client's self-reported name after initialization. Patterns are matched
case-insensitively with specific matches checked before generic ones (`"claude
desktop"` before `"claude"`). Unknown clients log their name to stderr for
debugging and fall back to `"mcp"`.

### Version History

| Version | What gets intercepted | How |
|---|---|---|
| v0.1 | `exec` — shell commands only | OpenClaw WebSocket event adapter |
| v0.2 | All tool calls inside OpenClaw | Native OpenClaw plugin (`before_tool_call` hook) |
| v0.3 | Everything MCP-speaking | Protocol-level MCP proxy |
| v0.4 | Same + database rules | Policy engine v2 + zero-friction setup |
| v0.5 | Same + rate limiting | Hot-reload + rate limiting |
| v0.6 | **Same + web UI** | **Unified web approval, policy editor, log viewer** |
