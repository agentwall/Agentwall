import * as readline from 'node:readline';

const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const AUTO_DENY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Prompts the user to approve or deny a tool call.
 * Blocks until the user responds or times out (5 min → auto-deny).
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} params
 * @returns {Promise<boolean>} true = approved, false = denied
 */
export async function promptApproval(toolName, params) {
  const lines = formatParams(params);

  process.stderr.write('\n');
  process.stderr.write(`  ${BOLD}${YELLOW}⚠  AgentWall — tool approval required${RESET}\n`);
  process.stderr.write(`  tool:  ${BOLD}${toolName}${RESET}\n`);
  process.stderr.write(`  params:\n`);
  for (const line of lines) {
    process.stderr.write(`    ${DIM}${line}${RESET}\n`);
  }
  process.stderr.write('\n');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });

    let resolved = false;
    const finish = (approved) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      rl.close();
      resolve(approved);
    };

    const timeout = setTimeout(() => {
      process.stderr.write(
        `\n  ${YELLOW}⏱ Auto-denied after 5 minutes of no response.${RESET}\n\n`
      );
      finish(false);
    }, AUTO_DENY_TIMEOUT_MS);

    process.stderr.write('  allow? [y/N] ');

    rl.on('line', (input) => {
      const answer = input.trim().toLowerCase();
      finish(answer === 'y' || answer === 'yes');
    });

    rl.on('close', () => finish(false));
  });
}

function formatParams(params) {
  try {
    return JSON.stringify(params, null, 2).split('\n').slice(0, 15);
  } catch {
    return [String(params)];
  }
}
