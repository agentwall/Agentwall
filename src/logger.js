import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const LOG_DIR = path.join(os.homedir(), '.agentwall');
const LOG_PATH = path.join(LOG_DIR, 'decisions.jsonl');

/**
 * Appends a decision record to the JSONL log.
 */
export function logDecision({ toolName, params, decision, reason, ctx }) {
  const record = {
    timestamp: new Date().toISOString(),
    toolName,
    params,
    decision,
    reason,
    agentId: ctx?.agentId,
    sessionKey: ctx?.sessionKey,
    runId: ctx?.runId,
  };

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[AgentWall] Failed to write log: ${err.message}\n`);
  }
}
