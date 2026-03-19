import { createBeforeToolCallHandler } from './src/hook.js';

export default {
  id: 'agentwall',
  name: 'AgentWall',
  description: 'Intercepts all tool calls and prompts for user approval',
  version: '0.2.0',

  activate(api) {
    api.logger.info('[AgentWall] v0.2 activated — intercepting all tool calls');

    const handler = createBeforeToolCallHandler(api.logger);
    api.on('before_tool_call', handler);
  }
};
