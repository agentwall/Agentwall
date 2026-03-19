import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const AGENTWALL_DIR = join(homedir(), ".agentwall");
const IGNORED_FILE = join(AGENTWALL_DIR, "ignored.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupportedClient = {
  id: string;
  name: string;
  kind: "mcp" | "plugin";
  configPaths: string[];
};

export type ServerEntry = {
  name: string;
  protected: boolean;
  ignored: boolean;
  command?: string;
  args?: string[];
};

export type ClientEntry = {
  name: string;
  id: string;
  installed: boolean;
  configPath?: string;
  active: boolean;
  pendingRestart: boolean;
  servers: ServerEntry[];
  kind: "mcp" | "plugin";
};

export interface DetectedConfig {
  label: string;
  id: string;
  path: string;
  servers: Record<string, Record<string, unknown>>;
}

interface IgnoredEntry {
  client: string;
  server: string;
}

interface IgnoredFile {
  ignored: IgnoredEntry[];
}

// ---------------------------------------------------------------------------
// Supported clients registry
// ---------------------------------------------------------------------------

function buildSupportedClients(): SupportedClient[] {
  const home = homedir();
  const os = platform();

  return [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      kind: "mcp",
      configPaths:
        os === "darwin"
          ? [join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")]
          : os === "win32"
            ? [join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json")]
            : [join(home, ".config", "claude", "claude_desktop_config.json")],
    },
    {
      id: "cursor",
      name: "Cursor",
      kind: "mcp",
      configPaths:
        os === "win32"
          ? [join(process.env.APPDATA ?? "", "Cursor", "mcp.json")]
          : [join(home, ".cursor", "mcp.json")],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      kind: "mcp",
      configPaths: [join(home, ".codeium", "windsurf", "mcp_config.json")],
    },
    {
      id: "claude-code",
      name: "Claude Code",
      kind: "mcp",
      configPaths: [
        join(home, ".claude", "settings.json"),
        join(home, ".claude.json"),
        join(home, ".mcp.json"),
      ],
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      kind: "plugin",
      configPaths: [join(home, ".openclaw", "openclaw.json")],
    },
  ];
}

export function getSupportedClients(): SupportedClient[] {
  return buildSupportedClients();
}

// ---------------------------------------------------------------------------
// Config detection (shared with CLI)
// ---------------------------------------------------------------------------

export function isAlreadyWrapped(entry: Record<string, unknown>): boolean {
  if (entry.command !== "agentwall") return false;
  const args = entry.args;
  if (!Array.isArray(args)) return false;
  return args.includes("proxy") && args.includes("--");
}

export function isHttpTransport(entry: Record<string, unknown>): boolean {
  return typeof entry.url === "string" && !entry.command;
}

export function wrapServerEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const origCommand = entry.command as string;
  const origArgs = (entry.args ?? []) as string[];
  return {
    ...entry,
    command: "agentwall",
    args: ["proxy", "--", origCommand, ...origArgs],
  };
}

export function backupFile(filePath: string): string {
  let bakPath = filePath + ".bak";
  let counter = 2;
  while (existsSync(bakPath)) {
    bakPath = filePath + `.bak.${counter}`;
    counter++;
  }
  copyFileSync(filePath, bakPath);
  return bakPath;
}

export function shortPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

export function countProtection(
  servers: Record<string, Record<string, unknown>>,
): { total: number; protected: number } {
  let total = 0;
  let protectedCount = 0;
  for (const entry of Object.values(servers)) {
    total++;
    if (isAlreadyWrapped(entry)) protectedCount++;
  }
  return { total, protected: protectedCount };
}

/**
 * Detect all MCP configs on disk. Returns the raw server entries per client.
 * Used by both the CLI (setup/status) and the web API.
 */
export function detectConfigs(): DetectedConfig[] {
  const found: DetectedConfig[] = [];
  const clients = getSupportedClients();

  for (const client of clients) {
    if (client.kind !== "mcp") continue;
    let foundForClient = false;
    for (const configPath of client.configPaths) {
      if (foundForClient) break;
      if (!existsSync(configPath)) continue;
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);
        const servers = parsed.mcpServers;
        if (servers && typeof servers === "object" && !Array.isArray(servers)) {
          found.push({ label: client.name, id: client.id, path: configPath, servers });
          foundForClient = true;
        }
      } catch {
        // skip unparseable configs
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Ignored servers management
// ---------------------------------------------------------------------------

export function readIgnored(): IgnoredEntry[] {
  if (!existsSync(IGNORED_FILE)) return [];
  try {
    const raw = readFileSync(IGNORED_FILE, "utf-8");
    const parsed = JSON.parse(raw) as IgnoredFile;
    return Array.isArray(parsed.ignored) ? parsed.ignored : [];
  } catch {
    return [];
  }
}

function writeIgnored(entries: IgnoredEntry[]): void {
  mkdirSync(AGENTWALL_DIR, { recursive: true });
  writeFileSync(IGNORED_FILE, JSON.stringify({ ignored: entries }, null, 2) + "\n");
}

export function ignoreServer(clientId: string, serverName: string): void {
  const entries = readIgnored();
  const alreadyIgnored = entries.some(
    (e) => e.client === clientId && e.server === serverName,
  );
  if (!alreadyIgnored) {
    entries.push({ client: clientId, server: serverName });
    writeIgnored(entries);
  }
}

export function unignoreServer(clientId: string, serverName: string): void {
  const entries = readIgnored().filter(
    (e) => !(e.client === clientId && e.server === serverName),
  );
  writeIgnored(entries);
}

function isIgnored(clientId: string, serverName: string, ignoredList: IgnoredEntry[]): boolean {
  return ignoredList.some((e) => e.client === clientId && e.server === serverName);
}

/**
 * Find the best config path for a client. Prefers a file that actually
 * contains `mcpServers`; falls back to the first existing file so we can
 * still detect "installed" status.
 */
function resolveConfigPath(
  configPaths: string[],
): { configPath: string | undefined; hasMcpServers: boolean } {
  let firstExisting: string | undefined;

  for (const p of configPaths) {
    if (!existsSync(p)) continue;
    if (!firstExisting) firstExisting = p;
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)) {
        return { configPath: p, hasMcpServers: true };
      }
    } catch {
      // skip unparseable
    }
  }

  return { configPath: firstExisting, hasMcpServers: false };
}

// ---------------------------------------------------------------------------
// Protect a single server in a client config
// ---------------------------------------------------------------------------

export function protectServer(
  clientId: string,
  serverName: string,
): ClientEntry | null {
  const clients = getSupportedClients();
  const clientDef = clients.find((c) => c.id === clientId);
  if (!clientDef || clientDef.kind !== "mcp") return null;

  const { configPath } = resolveConfigPath(clientDef.configPaths);
  if (!configPath) return null;

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== "object") return null;

  const entry = servers[serverName];
  if (!entry) return null;
  if (isAlreadyWrapped(entry)) {
    return getClientEntry(clientId);
  }
  if (typeof entry.command !== "string") return null;

  backupFile(configPath);
  parsed.mcpServers[serverName] = wrapServerEntry(entry);
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");

  unignoreServer(clientId, serverName);

  return getClientEntry(clientId);
}

// ---------------------------------------------------------------------------
// Build full client entries for the API
// ---------------------------------------------------------------------------

function getClientEntry(clientId: string): ClientEntry | null {
  const clients = getSupportedClients();
  const clientDef = clients.find((c) => c.id === clientId);
  if (!clientDef) return null;

  const ignoredList = readIgnored();
  return buildClientEntry(clientDef, ignoredList);
}

function buildClientEntry(client: SupportedClient, ignoredList: IgnoredEntry[]): ClientEntry {
  if (client.kind === "plugin") {
    return buildPluginClientEntry(client);
  }

  const { configPath, hasMcpServers } = resolveConfigPath(client.configPaths);

  if (!configPath) {
    return {
      id: client.id,
      name: client.name,
      kind: client.kind,
      installed: false,
      active: false,
      pendingRestart: false,
      servers: [],
    };
  }

  let servers: ServerEntry[] = [];
  if (hasMcpServers) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      const mcpServers = parsed.mcpServers;
      if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
        for (const [name, entry] of Object.entries(mcpServers)) {
          const serverObj = entry as Record<string, unknown>;
          servers.push({
            name,
            protected: isAlreadyWrapped(serverObj),
            ignored: isIgnored(client.id, name, ignoredList),
            command: typeof serverObj.command === "string" ? serverObj.command : undefined,
            args: Array.isArray(serverObj.args) ? serverObj.args as string[] : undefined,
          });
        }
      }
    } catch {
      // config exists but unparseable
    }
  }

  return {
    id: client.id,
    name: client.name,
    kind: client.kind,
    installed: true,
    configPath,
    active: false,
    pendingRestart: false,
    servers,
  };
}

function buildPluginClientEntry(client: SupportedClient): ClientEntry {
  let installed = false;
  let configPath: string | undefined;

  for (const p of client.configPaths) {
    if (existsSync(p)) {
      installed = true;
      configPath = p;
      break;
    }
  }

  return {
    id: client.id,
    name: client.name,
    kind: client.kind,
    installed,
    configPath,
    active: false,
    pendingRestart: false,
    servers: [],
  };
}

/**
 * Returns all client entries with disk-level state.
 * `active` and `pendingRestart` are set to false — the web server
 * overlays runtime state from its in-memory maps.
 */
export function getClients(): ClientEntry[] {
  const clients = getSupportedClients();
  const ignoredList = readIgnored();
  return clients.map((c) => buildClientEntry(c, ignoredList));
}
