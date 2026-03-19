# AgentWall v0.1.0 — Build Log

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
