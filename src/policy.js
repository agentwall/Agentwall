/**
 * Policy rules for tool calls.
 *
 * 'allow'  — auto-allow, no prompt
 * 'block'  — auto-block, no prompt
 * 'prompt' — ask the user (default for everything else)
 */

const AUTO_ALLOW = new Set([
  // Add tools here that you always trust, e.g.:
  // 'list_directory',
  // 'read_file',
]);

const AUTO_BLOCK = new Set([
  // Add tools here that should never run, e.g.:
  // 'some_dangerous_tool',
]);

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} _params
 * @returns {'allow' | 'block' | 'prompt'}
 */
export function getPolicy(toolName, _params) {
  if (AUTO_BLOCK.has(toolName)) return 'block';
  if (AUTO_ALLOW.has(toolName)) return 'allow';
  return 'prompt';
}
