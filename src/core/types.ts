export interface ActionProposal {
  approvalId: string;
  runtime:    Runtime;
  command:    string;
  workingDir: string;
  toolName?:  string;
  args?:      Record<string, unknown>;
  toolInput?: unknown;
  sessionId?: string;
  agentId?:   string;
}

export type Runtime = "openclaw" | "claude-code" | "cursor" | "windsurf" | "claude-desktop" | "mcp";

export type DecisionVerdict = "allow" | "deny" | "ask";

export type DecisionReason =
  | "policy"
  | "user"
  | "auto-allow"
  | "rate-limit";

export type Decision = {
  decision: DecisionVerdict;
  reason:   DecisionReason;
  message?: string;
};

export type LimitRule = {
  tool:   string;
  max:    number;
  window: number;
};

export interface LogEntry {
  ts:         string;
  runtime:    Runtime;
  decision:   DecisionVerdict;
  resolvedBy: DecisionReason;
  command:    string;
  workingDir: string;
  approvalId: string;
  sessionId:  string;
  agentId:    string;
}

// ---------------------------------------------------------------------------
// MCP proxy types
// ---------------------------------------------------------------------------

export interface McpProxyOptions {
  serverCommand: string;
  serverArgs:    string[];
  serverEnv?:    Record<string, string>;
  serverCwd?:    string;
  port?:         number;
}
