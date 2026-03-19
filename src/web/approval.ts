import { randomUUID } from "node:crypto";

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
    return new Promise((resolve) => {
      const id = randomUUID();

      const timer = setTimeout(() => {
        this.pending.delete(id);
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
          this.onResolved?.(id, decision);
          resolve(decision);
        },
        timer,
      };

      this.pending.set(id, approval);
      this.onNew?.(approval);
    });
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
