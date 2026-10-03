// INTEL-3: reviewer-first PR body layout. Pure, no I/O, reuses data renderPrBody already receives
// (intake task, verify changed_files/checks, wall files). Lives outside engine10/ to keep the core line budget.
/** `shared`: files and check are run-wide (every criterion carries the same set), not a per-criterion mapping.
 *  `failed`: Wall files that failed or never ran; they are never shown as proving. */
export interface CriterionRow { text: string; files?: string[]; check?: string; shared?: boolean; failed?: string[] }
/** Hard cap on rendered lines so a reviewer reads the body in 60 seconds. Overflow is cut with a "+N more" line, never silently. */
export const PR_BODY_LINE_BUDGET = 60;
const W = 140, MAX_FILES = 3, MAX_NOT_PROVEN = 10, MAX_GROUP = 12, MAX_STAGES = 8, MIN_CRITERIA_LINES = 4;
export const clip = (s: string): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > W ? `${t.slice(0, W - 3)}...` : t; };
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** At most `max` lines; when cut, the last line is "+N more <noun>" counting what was dropped. */
function fit(lines: string[], max: number, noun: string): string[] {
  if (lines.length <= max) return lines;
  const keep = Math.max(0, max - 1);
  return [...lines.slice(0, keep), `+${lines.length - keep} more ${noun}`];
}
type Outputs = Partial<Record<string, Record<string, unknown>>>;
export function intakeTask(outputs: Outputs): string { return typeof outputs.intake?.["task"] === "string" ? (outputs.intake["task"] as string) : ""; }
/** Criteria are the intake task bullets (or its first line); each maps to the run's changed files and the Wall test results. */
export function deriveCriteria(outputs: Outputs): CriterionRow[] {
  const all = intakeTask(outputs).split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = all.filter((l) => /^([-*+]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?/, ""));
  const files = arr<string>(outputs.verify?.["changed_files"]);
  const checks = arr<{ name: string; result: string }>(outputs.verify?.["checks"]);
  const wall = arr<{ path: string }>(outputs.wall?.["files"]).map((f) => f.path.split("/").pop() ?? f.path);
  const res = (w: string): string | undefined => checks.find((k) => k.name.endsWith(w))?.result;
  const proof = wall.filter((w) => res(w) === "pass").map((w) => `${w} (pass)`);
  const failed = wall.filter((w) => res(w) !== "pass").map((w) => `${w} ${res(w) === undefined ? "not run" : "failed"}`);
  return (bullets.length > 0 ? bullets : all.slice(0, 1)).map((text) => ({ text, files, shared: true, check: proof.length > 0 ? `Wall ${proof.join(", ")}` : undefined, failed }));
}
function criterionLines(r: CriterionRow): string[] {
  const f = r.files ?? [];
  const files = f.length > 0 ? `${f.slice(0, MAX_FILES).join(", ")}${f.length > MAX_FILES ? ` (+${f.length - MAX_FILES} more)` : ""}` : "files not recorded";
  const bad = (r.failed ?? []).length > 0 ? ` (${r.failed!.join(", ")})` : "";
  const check = r.check ? clip(r.check) : bad ? `UNPROVEN${bad}` : "no check recorded";
  const sh = r.shared ? " (shared by all criteria)" : "";
  return [`- ${clip(r.text)}`, `  files${sh}: ${files}; check${sh}: ${check}`];
}
export interface Parts { contract: string; verdictLine: string; timing: string[]; notProven: string[]; receipt: string | null; group: string[]; rows: CriterionRow[]; legacy: boolean; note?: string }
/** Order: contract, verdict, criteria, stage times, receipt, unit table, NOT PROVEN last. `legacy` (no contract, no criteria, no intake task) keeps the pre-INTEL-3 bytes. */
export function layoutPrBody(p: Parts): string {
  if (p.legacy) { // raw: no clip, no fit, so pre-INTEL-3 bytes are preserved exactly
    const st = p.timing.length > 0 ? ["Stage times:", ...p.timing, ""] : [];
    return `${[p.verdictLine, ...(p.note ? [`Note: ${p.note}`] : []), "", ...st, "NOT PROVEN:", ...(p.notProven.length > 0 ? p.notProven.map((x) => `- ${x}`) : ["- none"]), ...(p.receipt ? ["", `Receipt: ${p.receipt}`] : []), ...(p.group.length ? ["", ...p.group] : [])].join("\n")}\n`;
  }
  const unproven = p.rows.filter((r) => !r.check).map((r) => `criterion has no passing check: ${r.text}`);
  const all = [...p.notProven, ...unproven.filter((u) => !p.notProven.includes(u))];
  const timing = p.timing.length > 0 ? [...fit(["Stage times:", ...p.timing], MAX_STAGES, "stages"), ""] : [];
  const np = ["NOT PROVEN:", ...fit(all.length > 0 ? all.map((x) => `- ${clip(x)}`) : ["- none"], MAX_NOT_PROVEN, "not-proven items")];
  const receipt = p.receipt ? [`Receipt: ${p.receipt}`] : [];
  const group = p.group.length > 0 ? fit(p.group, MAX_GROUP, "unit lines") : [];
  const tail = [...timing, ...(receipt.length ? [...receipt, ""] : []), ...(group.length ? [...group, ""] : []), ...np];
  const room = Math.max(MIN_CRITERIA_LINES, PR_BODY_LINE_BUDGET - (3 + 2 + tail.length + (p.note ? 1 : 0))); // contract, verdict, blank + criteria header, trailing blank
  const keep = p.rows.length * 2 <= room ? p.rows.length : Math.floor((room - 1) / 2); // whole criteria only, never half a pair
  const crit = p.rows.length === 0 ? ["- no acceptance criteria recorded"] : [...p.rows.slice(0, keep).flatMap(criterionLines), ...(keep < p.rows.length ? [`+${p.rows.length - keep} more criteria`] : [])];
  return `${[`Contract: ${p.contract ? clip(p.contract) : "not recorded"}`, p.verdictLine, ...(p.note ? [`Note: ${clip(p.note)}`] : []), "", "Acceptance criteria (files and proving check):", ...crit, "", ...tail].join("\n")}\n`;
}
