import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import type { ActionProposal, Decision } from "./types.js";

const AGENTWALL_DIR = join(homedir(), ".agentwall");
const POLICY_FILE = join(AGENTWALL_DIR, "policy.yaml");
const WORKSPACE_DIR = resolve(process.cwd());

interface PolicyRule {
  command?: string;
  path?: string;
  tool?: string;
  match?: Record<string, string>;
  url?: string;
}

interface PolicyConfig {
  deny?: PolicyRule[];
  allow?: PolicyRule[];
  ask?: PolicyRule[];
}

const VALID_TOP_KEYS = new Set(["deny", "allow", "ask"]);
const VALID_RULE_KEYS = new Set(["command", "path", "tool", "match", "url"]);

const DEFAULT_POLICY = `# AgentWall Policy
# Rules are evaluated in order: deny → allow → ask
# Glob patterns: * matches anything except /, ** matches everything including /
# Documentation: https://github.com/yourusername/agentwall

deny:
  # ── Filesystem: never touch credentials or system files ──────────────────
  - path: ~/.ssh/**
  - path: ~/.aws/**
  - path: ~/.gnupg/**
  - path: ~/.npmrc
  - path: ~/.netrc
  - path: /etc/**
  - path: /System/**

  # ── Shell: never pipe from the internet ──────────────────────────────────
  - command: "curl * | *"
  - command: "curl *|*"
  - command: "wget * | *"
  - command: "wget *|*"

  # ── Shell: never wipe root or home ───────────────────────────────────────
  - command: "rm -rf /"
  - command: "rm -rf ~"
  - command: "rm -rf /home"

  # ── Database: never drop, truncate, or wipe ──────────────────────────────
  - tool: "*"
    match:
      sql: "drop *"
  - tool: "*"
    match:
      sql: "truncate *"
  - tool: "*"
    match:
      query: "drop *"
  - tool: "*"
    match:
      query: "truncate *"
  - tool: "*"
    match:
      statement: "drop *"
  - tool: "*"
    match:
      statement: "truncate *"

ask:
  # ── Database: always confirm destructive writes ───────────────────────────
  - tool: "*"
    match:
      sql: "delete *"
  - tool: "*"
    match:
      sql: "alter *"
  - tool: "*"
    match:
      sql: "update *"
  - tool: "*"
    match:
      query: "delete *"
  - tool: "*"
    match:
      query: "alter *"
  - tool: "*"
    match:
      query: "update *"

  # ── Shell: confirm destructive commands ──────────────────────────────────
  - command: "rm -rf *"
  - command: "rm -r *"
  - command: "sudo *"
  - command: "chmod -R *"
  - command: "dd *"

  # ── Filesystem: confirm writes outside workspace ──────────────────────────
  - tool: "write_file"
    path: outside:workspace
  - tool: "edit"
    path: outside:workspace

allow:
  # ── Everything inside your workspace is trusted ───────────────────────────
  - path: workspace/**
`;

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i++;
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
    } else if (pattern[i] === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(pattern[i]);
    }
  }
  return new RegExp(`^${regex}$`);
}

function getNonWildcardPrefix(pattern: string): string {
  const idx = pattern.indexOf("*");
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

function expandPath(pattern: string): string {
  if (pattern.startsWith("~/") || pattern === "~") {
    return homedir() + pattern.slice(1);
  }
  if (pattern.startsWith("workspace/") || pattern === "workspace") {
    return WORKSPACE_DIR + pattern.slice("workspace".length);
  }
  return pattern;
}

function matchesCommand(command: string, pattern: string): boolean {
  if (globToRegex(pattern).test(command)) return true;

  const prefix = getNonWildcardPrefix(pattern);
  if (prefix.length > 0 && command.startsWith(prefix)) return true;

  return false;
}

function matchesPath(workingDir: string, pattern: string): boolean {
  if (workingDir === "") return false;

  if (pattern === "outside:workspace") {
    const normalized = resolve(workingDir);
    return normalized !== WORKSPACE_DIR && !normalized.startsWith(WORKSPACE_DIR + "/");
  }

  const expanded = expandPath(pattern);
  if (globToRegex(expanded).test(workingDir)) return true;

  if (expanded.endsWith("/**")) {
    const base = expanded.slice(0, -3);
    if (workingDir === base || workingDir.startsWith(base + "/")) return true;
  }

  return false;
}

function matchesTool(proposal: ActionProposal, pattern: string): boolean {
  const name = proposal.toolName ?? proposal.command;
  return globToRegex(pattern).test(name);
}

function matchesArgContent(proposal: ActionProposal, matchRules: Record<string, string>): boolean {
  const args = proposal.args;
  if (!args) return false;

  for (const [argName, pattern] of Object.entries(matchRules)) {
    const argValue = args[argName];
    if (argValue === undefined) return false;
    const valueStr = typeof argValue === "string" ? argValue : JSON.stringify(argValue);
    if (!globToRegex(pattern.toLowerCase()).test(valueStr.toLowerCase())) return false;
  }
  return true;
}

function matchesUrl(proposal: ActionProposal, pattern: string): boolean {
  const urlValue = proposal.args?.url ?? proposal.args?.uri;
  if (!urlValue) return false;
  return globToRegex(pattern).test(String(urlValue));
}

function ruleMatches(rule: PolicyRule, proposal: ActionProposal): boolean {
  const conditions: boolean[] = [];

  if (rule.command !== undefined) {
    conditions.push(matchesCommand(proposal.command, rule.command));
  }
  if (rule.path !== undefined) {
    conditions.push(matchesPath(proposal.workingDir, rule.path));
  }
  if (rule.tool !== undefined) {
    conditions.push(matchesTool(proposal, rule.tool));
  }
  if (rule.match !== undefined) {
    conditions.push(matchesArgContent(proposal, rule.match));
  }
  if (rule.url !== undefined) {
    conditions.push(matchesUrl(proposal, rule.url));
  }

  if (conditions.length === 0) return false;
  return conditions.every(Boolean);
}

export class PolicyEngine {
  readonly policyPath: string;
  readonly usingDefaults: boolean;
  private config: PolicyConfig;

  constructor() {
    this.policyPath = POLICY_FILE;

    if (!existsSync(POLICY_FILE)) {
      this.usingDefaults = true;
      this.config = yaml.load(DEFAULT_POLICY) as PolicyConfig;
      return;
    }

    this.usingDefaults = false;
    const raw = readFileSync(POLICY_FILE, "utf-8");

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      process.stderr.write(
        `\x1b[31merror:\x1b[0m Failed to parse ${POLICY_FILE}: ${(err as Error).message}\n` +
        `  Fix the YAML syntax in your policy file and try again.\n`
      );
      process.exit(1);
    }

    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      this.config = { deny: [], allow: [], ask: [] };
      return;
    }

    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!VALID_TOP_KEYS.has(key)) {
        process.stderr.write(
          `\x1b[31merror:\x1b[0m Unknown key "${key}" in ${POLICY_FILE}\n` +
          `  Valid keys are: deny, allow, ask. Remove or rename the unknown key.\n`
        );
        process.exit(1);
      }
    }

    this.config = obj as PolicyConfig;
    this.validateRules();
  }

  private validateRules(): void {
    for (const section of ["deny", "allow", "ask"] as const) {
      const rules = this.config[section];
      if (!rules) continue;

      if (!Array.isArray(rules)) {
        process.stderr.write(
          `\x1b[31merror:\x1b[0m "${section}" in ${this.policyPath} must be a list of rules.\n` +
          `  Each rule should have a "command" and/or "path" field.\n`
        );
        process.exit(1);
      }

      for (const rule of rules) {
        if (typeof rule !== "object" || rule === null) {
          process.stderr.write(
            `\x1b[31merror:\x1b[0m Invalid rule in "${section}" in ${this.policyPath}.\n` +
            `  Each rule must be an object with "command", "path", "tool", "match", and/or "url" fields.\n`
          );
          process.exit(1);
        }

        const ruleObj = rule as Record<string, unknown>;
        for (const key of Object.keys(ruleObj)) {
          if (!VALID_RULE_KEYS.has(key)) {
            process.stderr.write(
              `\x1b[31merror:\x1b[0m Unknown rule key "${key}" in "${section}" in ${this.policyPath}.\n` +
              `  Valid rule keys are: command, path, tool, match, url.\n`
            );
            process.exit(1);
          }
        }

        for (const key of ["command", "path", "tool", "url"] as const) {
          if (ruleObj[key] !== undefined && typeof ruleObj[key] !== "string") {
            process.stderr.write(
              `\x1b[31merror:\x1b[0m Invalid "${key}" value in "${section}" — must be a string.\n` +
              `  Wrap the value in quotes in your policy file.\n`
            );
            process.exit(1);
          }
        }

        if (ruleObj.match !== undefined) {
          if (typeof ruleObj.match !== "object" || ruleObj.match === null || Array.isArray(ruleObj.match)) {
            process.stderr.write(
              `\x1b[31merror:\x1b[0m Invalid "match" value in "${section}" — must be an object mapping argument names to glob patterns.\n`
            );
            process.exit(1);
          }
          for (const [k, v] of Object.entries(ruleObj.match as Record<string, unknown>)) {
            if (typeof v !== "string") {
              process.stderr.write(
                `\x1b[31merror:\x1b[0m Invalid match pattern for "${k}" in "${section}" — must be a string.\n`
              );
              process.exit(1);
            }
          }
        }
      }
    }
  }

  evaluate(proposal: ActionProposal): Decision {
    for (const rule of this.config.deny ?? []) {
      if (ruleMatches(rule, proposal)) return "deny";
    }

    // Non-path ask rules fire before path-based allow rules.
    // Prevents workspace/** allow from silently permitting rm -rf, sudo, DROP, etc.
    for (const rule of this.config.ask ?? []) {
      const hasPathCondition = rule.path !== undefined;
      if (!hasPathCondition && ruleMatches(rule, proposal)) {
        return "ask";
      }
    }

    for (const rule of this.config.allow ?? []) {
      if (ruleMatches(rule, proposal)) return "allow";
    }

    // Remaining ask rules (path-based)
    for (const rule of this.config.ask ?? []) {
      const hasPathCondition = rule.path !== undefined;
      if (hasPathCondition && ruleMatches(rule, proposal)) return "ask";
    }

    return "ask";
  }

  static defaultYaml(): string {
    return DEFAULT_POLICY;
  }
}
