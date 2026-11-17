// Small display helpers. No state, no fetches.
import type { RunRow } from "../api";

export const money = (r: Pick<RunRow, "cost_usd" | "partial_usd">): string =>
  typeof r.cost_usd === "number" ? `$${r.cost_usd.toFixed(2)}` : typeof r.partial_usd === "number" && r.partial_usd > 0 ? `$${r.partial_usd.toFixed(2)}+` : "unpriced";

export const duration = (s: number | null | undefined): string => {
  if (typeof s !== "number" || !Number.isFinite(s)) return "";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
};

export const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

export type Tone = "ok" | "warn" | "bad" | "live" | "";
/** Loki's label for a run, in the words a person acts on. */
const QUIET_MS = 2 * 3600 * 1000;
type Labelled = Pick<RunRow, "verdict" | "status" | "effective_verdict"> & Partial<Pick<RunRow, "last_event_at">>;
/** A run with no result is working only while it still reports: one silent for two hours was interrupted, and is shown as that. */
export const isWorking = (r: Labelled, now = Date.now()): boolean =>
  (r.status === "running" || r.verdict === null) && !(r.last_event_at && now - Date.parse(r.last_event_at) > QUIET_MS);
export function label(r: Labelled): { text: string; tone: Tone } {
  if (isWorking(r)) return { text: "Working", tone: "live" };
  if (r.status === "running" || r.verdict === null) return { text: "Interrupted", tone: "" };
  const v = String(r.effective_verdict ?? r.verdict).toUpperCase();
  if (v === "VERIFIED" || v === "ALREADY_SATISFIED") return { text: "Safe to merge", tone: "ok" };
  if (v.startsWith("PARTIAL")) return { text: "Needs you", tone: "warn" };
  if (v.startsWith("FAILED")) return { text: "Failed", tone: "bad" };
  if (v.startsWith("BLOCKED") || v.startsWith("SPEC_CONFLICT")) return { text: "Has a question", tone: "warn" };
  if (v.startsWith("CANCELLED")) return { text: "Stopped", tone: "" };
  return { text: v.charAt(0) + v.slice(1).toLowerCase(), tone: "" };
}

/** The repository a run belongs to, as the short name the sidebar shows. */
export const repoOf = (r: Pick<RunRow, "origin_repo"> & Partial<Pick<RunRow, "issue_ref">>): string => {
  const full = r.origin_repo ?? (r.issue_ref && /^[^/\s]+\/[^#\s]+#\d+$/.test(r.issue_ref) ? r.issue_ref.split("#")[0]! : null); // a run on a local remote records no origin: the issue it was given names the repository
  return full ? full.split("/").pop() ?? full : "unknown";
};
export const runTitle = (r: Pick<RunRow, "title" | "issue_ref" | "run_id">): string => r.title || r.issue_ref || r.run_id;
