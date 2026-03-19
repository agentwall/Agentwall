import { promptApproval } from './approver.js';
import { logDecision } from './logger.js';
import { getPolicy } from './policy.js';

/**
 * Creates the before_tool_call hook handler.
 *
 * Return values:
 *   { block: true, blockReason: '...' }  → tool call is blocked
 *   { params: { ... } }                  → tool call runs with modified params
 *   undefined / void                     → tool call runs with original params
 */
export function createBeforeToolCallHandler(logger) {
  return async (event, ctx) => {
    const { toolName, params } = event;

    logger.info(`[AgentWall] Tool call intercepted: ${toolName}`);

    const policy = getPolicy(toolName, params);

    if (policy === 'block') {
      logger.warn(`[AgentWall] Blocked by policy: ${toolName}`);
      logDecision({ toolName, params, decision: 'blocked', reason: 'policy', ctx });
      return {
        block: true,
        blockReason: `AgentWall: tool '${toolName}' is blocked by policy`
      };
    }

    if (policy === 'allow') {
      logger.info(`[AgentWall] Auto-allowed: ${toolName}`);
      logDecision({ toolName, params, decision: 'allowed', reason: 'auto-allow', ctx });
      return;
    }

    let approved = false;
    try {
      approved = await promptApproval(toolName, params);
    } catch (err) {
      logger.error(`[AgentWall] Approval prompt failed: ${err.message}. Blocking for safety.`);
      logDecision({ toolName, params, decision: 'blocked', reason: 'prompt-error', ctx });
      return {
        block: true,
        blockReason: 'AgentWall: approval prompt failed — blocked for safety'
      };
    }

    logDecision({
      toolName,
      params,
      decision: approved ? 'approved' : 'blocked',
      reason: 'user',
      ctx
    });

    if (!approved) {
      return {
        block: true,
        blockReason: `AgentWall: user denied tool call '${toolName}'`
      };
    }
  };
}
