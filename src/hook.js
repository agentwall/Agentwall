import { askUser, printDecision } from '../dist/core/prompt.js';
import { logDecision } from './logger.js';
import { randomUUID } from 'node:crypto';

const SHELL_TOOL_NAMES = new Set([
  'bash', 'exec', 'shell', 'run_command', 'execute_command',
  'run_terminal_command', 'terminal',
]);

function extractCommand(toolName, params) {
  if (SHELL_TOOL_NAMES.has(toolName)) {
    const cmd = params?.command ?? params?.cmd ?? params?.script;
    if (typeof cmd === 'string') return cmd;
  }
  return toolName;
}

function buildLogEntry(proposal, decision, resolvedBy, ctx) {
  return {
    ts: new Date().toISOString(),
    runtime: proposal.runtime,
    decision,
    resolvedBy,
    command: proposal.command,
    workingDir: proposal.workingDir || '',
    approvalId: proposal.approvalId,
    sessionId: ctx?.sessionKey || '',
    agentId: ctx?.agentId || '',
  };
}

/**
 * Creates the before_tool_call hook handler.
 *
 * Return values:
 *   { block: true, blockReason: '...' }  → tool call is blocked
 *   { params: { ... } }                  → tool call runs with modified params
 *   undefined / void                     → tool call runs with original params
 */
export function createBeforeToolCallHandler(logger, options = {}) {
  const { eventLogger, policy } = options;

  return async (event, ctx) => {
    const { toolName, params } = event;

    logger.info(`[AgentWall] Tool call intercepted: ${toolName}`);

    const command = extractCommand(toolName, params);

    const proposal = {
      approvalId: randomUUID(),
      runtime: 'openclaw',
      command,
      toolName: toolName,
      args: params,
      workingDir: params?.path || params?.file || '',
      toolInput: params,
    };

    if (policy) {
      const result = policy.evaluate(proposal);

      if (result.decision === 'deny') {
        logger.warn(`[AgentWall] Blocked by policy: ${toolName}(${command})`);
        printDecision('deny', `${toolName}(${command})`, result.message || 'policy rule matched');
        logDecision({ toolName, params, decision: 'blocked', reason: 'policy', ctx });
        eventLogger?.log(buildLogEntry(proposal, 'deny', 'policy', ctx));
        return {
          block: true,
          blockReason: result.message || `AgentWall: tool '${toolName}' is blocked by policy`,
        };
      }

      if (result.decision === 'allow') {
        logger.info(`[AgentWall] Auto-allowed by policy: ${toolName}(${command})`);
        printDecision('allow', `${toolName}(${command})`, 'policy');
        logDecision({ toolName, params, decision: 'allowed', reason: 'policy', ctx });
        eventLogger?.log(buildLogEntry(proposal, 'allow', 'policy', ctx));
        return;
      }
    }

    let userDecision = 'deny';
    try {
      userDecision = await askUser(proposal, 'flagged as sensitive');
    } catch (err) {
      logger.error(`[AgentWall] Approval prompt failed: ${err.message}. Blocking for safety.`);
      printDecision('deny', toolName, 'prompt error — blocked for safety');
      logDecision({ toolName, params, decision: 'blocked', reason: 'prompt-error', ctx });
      eventLogger?.log(buildLogEntry(proposal, 'deny', 'prompt-error', ctx));
      return {
        block: true,
        blockReason: 'AgentWall: approval prompt failed — blocked for safety'
      };
    }

    const approved = userDecision === 'allow';
    printDecision(userDecision, toolName, approved ? 'user approved' : 'user denied');
    logDecision({
      toolName,
      params,
      decision: approved ? 'approved' : 'blocked',
      reason: 'user',
      ctx
    });
    eventLogger?.log(buildLogEntry(proposal, approved ? 'allow' : 'deny', 'user', ctx));

    if (!approved) {
      return {
        block: true,
        blockReason: `AgentWall: user denied tool call '${toolName}'`
      };
    }
  };
}
