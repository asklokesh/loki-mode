// The one display mapping for run outcomes and the one ANSI stripper (RELEASE-11 A4b). No enum string is rendered anywhere: every
// surface calls displayOutcome and prints its label. An unknown value is humanized, never shown as a raw enum.

export type OutcomeTone = "good" | "warn" | "bad" | "neutral";
export interface Outcome { label: string; tone: OutcomeTone }

const UNCHECKED: Outcome = { label: "Unverified (signature not checked)", tone: "warn" };
const MAP: Record<string, Outcome> = {
  VERIFIED: { label: "Verified", tone: "good" },
  PARTIAL: { label: "Partly verified", tone: "warn" },
  FAILED: { label: "Failed", tone: "bad" },
  BLOCKED: { label: "Needs your answer", tone: "warn" },
  SPEC_CONFLICT: { label: "Needs your answer", tone: "warn" },
  ALREADY_SATISFIED: { label: "Already done", tone: "good" },
  UNVERIFIED: UNCHECKED,
  TAMPERED: { label: "Tampered", tone: "bad" },
  RUNNING: { label: "Running", tone: "neutral" },
};
const BUDGET = /^(BUDGET|COST_CAP|CAP_REACHED|OVER_BUDGET|STOPPED_BUDGET)/;

/** Maps a stored or derived verdict (including "X (signature not checked)" and "X (unattested)") to its one label and tone. */
export function displayOutcome(verdict: string | null | undefined): Outcome {
  if (typeof verdict !== "string" || !verdict.trim()) return { label: "Running", tone: "neutral" };
  const raw = verdict.trim();
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  if (MAP[key]) return MAP[key]!;
  if (BUDGET.test(key)) return { label: "Stopped (budget)", tone: "warn" };
  if (/_?\(SIGNATURE_NOT_CHECKED\)$/.test(key) || /_?\(UNATTESTED\)$/.test(key)) return UNCHECKED;
  const words = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: "neutral" };
}

// CSI sequences, OSC sequences and lone ESC; plus the ESC-less remnants ("[31m") that logs keep after the ESC byte is dropped.
const ANSI_FULL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const ANSI_BARE = /\[\d{1,3}(?:;\d{1,3})*m/g;

/** Removes every ANSI escape, including the ones whose ESC byte was already dropped upstream. */
export function stripAnsi(s: string): string {
  if (typeof s !== "string") return "";
  return s.replace(ANSI_FULL, "").replace(ANSI_BARE, "").replace(/\u001b/g, "");
}
