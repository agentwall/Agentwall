import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export type PendingApproval = {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  runtime: string;
  timestamp: Date;
  resolve: (decision: "allow" | "deny") => void;
  timer: NodeJS.Timeout;
};

export class ApprovalQueue {
  private pending = new Map<string, PendingApproval>();
  private inflight = new Map<string, Promise<"allow" | "deny">>();
  private onNew?: (approval: PendingApproval) => void;
  private onResolved?: (id: string, decision: "allow" | "deny") => void;

  onNewApproval(cb: (approval: PendingApproval) => void): void {
    this.onNew = cb;
  }

  onApprovalResolved(cb: (id: string, decision: "allow" | "deny") => void): void {
    this.onResolved = cb;
  }

  request(
    toolName: string,
    params: Record<string, unknown>,
    runtime: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<"allow" | "deny"> {
    const dedupeKey = toolName + "\0" + JSON.stringify(params);
    const existing = this.inflight.get(dedupeKey);
    if (existing) return existing;

    const promise = new Promise<"allow" | "deny">((resolve) => {
      const id = randomUUID();

      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.inflight.delete(dedupeKey);
        this.onResolved?.(id, "deny");
        resolve("deny");
      }, timeoutMs);

      const approval: PendingApproval = {
        id,
        toolName,
        params,
        runtime,
        timestamp: new Date(),
        resolve: (decision) => {
          clearTimeout(timer);
          this.pending.delete(id);
          this.inflight.delete(dedupeKey);
          this.onResolved?.(id, decision);
          resolve(decision);
        },
        timer,
      };

      this.pending.set(id, approval);
      this.onNew?.(approval);
      fireSystemNotification(toolName, runtime);
    });

    this.inflight.set(dedupeKey, promise);
    return promise;
  }

  decide(id: string, decision: "allow" | "deny"): boolean {
    const approval = this.pending.get(id);
    if (!approval) return false;
    approval.resolve(decision);
    return true;
  }

  getPending(): PendingApproval[] {
    return Array.from(this.pending.values());
  }
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function fireSystemNotification(toolName: string, runtime: string): void {
  if (process.platform !== "darwin") return;

  const title = escapeAppleScript("AgentWall — Approval Required");
  const message = escapeAppleScript(`${runtime}: ${toolName} wants to run`);
  const subtitle = escapeAppleScript("Open localhost:7823 to approve or deny");

  const script = `display notification "${message}" with title "${title}" subtitle "${subtitle}"`;

  execFile("osascript", ["-e", script], (err) => {
    if (err) {
      process.stderr.write(`[AgentWall] Notification failed: ${err.message}\n`);
    }
  });
}
