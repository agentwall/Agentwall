import { createBeforeToolCallHandler } from './src/hook.js';
import { ApprovalQueue } from './dist/web/approval.js';
import { setWebApprovalQueue } from './dist/core/prompt.js';
import { AgentWallWebServer } from './dist/web/server.js';
import { EventLogger } from './dist/core/logger.js';
import { PolicyEngine } from './dist/core/policy.js';
import * as net from 'node:net';
import * as http from 'node:http';

const WEB_PORT = 7823;

function isPortReachable(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function remoteApprovalRequest(toolName, params, runtime) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ toolName, params, runtime });
    const req = http.request({
      hostname: '127.0.0.1',
      port: WEB_PORT,
      path: '/api/request-approval',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 35000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(result.decision || 'deny');
        } catch {
          resolve('deny');
        }
      });
    });
    req.on('error', () => resolve('deny'));
    req.on('timeout', () => { req.destroy(); resolve('deny'); });
    req.write(data);
    req.end();
  });
}

export default {
  id: 'agentwall',
  name: 'AgentWall',
  description: 'Intercepts all tool calls and prompts for user approval',
  version: '0.2.0',

  activate(api) {
    api.logger.info('[AgentWall] v0.2 activated — intercepting all tool calls');

    const policy = new PolicyEngine();
    let webServer = null;

    const eventLogger = new EventLogger({
      onEntry: (entry) => webServer?.notifyLogEntry(entry),
    });

    const handler = createBeforeToolCallHandler(api.logger, { eventLogger });
    api.on('before_tool_call', handler);

    isPortReachable(WEB_PORT).then((inUse) => {
      if (inUse) {
        process.stderr.write(`[AgentWall] Web UI already running at http://localhost:${WEB_PORT}\n`);
        const remoteQueue = {
          request: (toolName, params, runtime) =>
            remoteApprovalRequest(toolName, params, runtime),
        };
        setWebApprovalQueue(remoteQueue);
        return;
      }

      const approvalQueue = new ApprovalQueue();
      setWebApprovalQueue(approvalQueue);

      webServer = new AgentWallWebServer({
        port: WEB_PORT,
        policyPath: policy.policyPath,
        logDir: eventLogger.logDir,
        approvalQueue,
      });

      webServer.start()
        .then(() => {
          process.stderr.write(`[AgentWall] Web UI available at http://localhost:${WEB_PORT}\n`);
        })
        .catch((err) => {
          process.stderr.write(`[AgentWall] Web server failed: ${err.message}\n`);
        });
    });
  }
};
