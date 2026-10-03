// Audit helper: one row per UI-initiated action. Never throws (an audit failure must not break the action) and never stores secrets.
import type { Db } from "../db/migrate.ts";
import { actions } from "../db/schema.ts";

export type AuditEntry = { actor?: string; kind: string; target?: string; result: string; detail?: string };

const clip = (s: string | undefined, n: number): string | null => (s === undefined ? null : s.slice(0, n));

/** Records an action. Returns true when the row was written. */
export function audit(db: Db, e: AuditEntry): boolean {
  try {
    db.insert(actions).values({ ts: new Date().toISOString(), actor: e.actor ?? "local", kind: e.kind, target: clip(e.target, 500), result: e.result, detail: clip(e.detail, 2000) }).run();
    return true;
  } catch { return false; }
}
