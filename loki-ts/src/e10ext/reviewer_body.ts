// INTEL-3: reviewer-first PR body, pure rendering from data the engine already holds. Order: what was asked, what changed, how it was tested, NOT PROVEN, receipt. Absent data
// prints "not recorded", never a number. Task text is untrusted: truncated, never executed.
export interface ReviewerBodyInput {
  verdict: string; draftReason: string | null; notProven: string[];
  receiptPath: string | null; receiptSha256: string | null; signed: boolean | null; runId: string;
  outputs: Partial<Record<string, Record<string, unknown>>>;
}
const MAX_CRITERIA = 8, MAX_FILES = 10, MAX_CMDS = 5, W = 160;
const clip = (s: string): string => (s.length > W ? `${s.slice(0, W - 3)}...` : s);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const more = (all: string[], max: number): string[] => [...all.slice(0, max), ...(all.length > max ? [`(+${all.length - max} more)`] : [])];
const isItem = (l: string): boolean => /^([-*+]|\d+[.)])\s+/.test(l);
function acceptance(all: string[]): string[] {
  const at = all.findIndex((l) => /^#+\s*acceptance criteria/i.test(l));
  const rest = all.slice(at + 1), end = rest.findIndex((l) => /^#+\s/.test(l)), sect = end < 0 ? rest : rest.slice(0, end);
  return at >= 0 && sect.some(isItem) ? sect : all; // the issue's own acceptance section is the contract when it has items
}
function criteria(task: string): string[] {
  const lines = acceptance(task.split("\n").map((l) => l.trim()).filter(Boolean));
  const items = lines.filter((l) => /^([-*+]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?/, ""));
  return more((items.length > 0 ? items : lines.slice(0, 1)).map(clip), MAX_CRITERIA);
}
function tested(o: ReviewerBodyInput["outputs"]): string[] {
  if (!o.verify) return ["- Tests: not recorded"];
  const checks = arr<{ name: string; cmd: string; result: string; n?: number }>(o.verify["checks"]);
  const by = (r: string): number => checks.filter((c) => c.result === r).length;
  const ran = checks.reduce((n, c) => n + (typeof c.n === "number" ? c.n : 0), 0);
  const out = [`- Checks: ${by("pass")} passed, ${by("fail")} failed, ${by("not_run")} not run, ${by("flaky")} flaky${ran > 0 ? ` (${ran} individual tests counted)` : ""}`];
  out.push(...more(checks.map((c) => `- Command: \`${clip(c.cmd)}\` -> ${c.result}`), MAX_CMDS));
  const base = o.wall?.["base_run"] as { fail?: number; pass?: number } | undefined;
  const wfiles = arr<{ path: string }>(o.wall?.["files"]).map((f) => f.path.split("/").pop() ?? f.path);
  if (wfiles.length > 0) {
    const after = checks.filter((c) => wfiles.some((f) => c.name.endsWith(f)));
    out.push(`- Target tests (written before the fix): ${wfiles.join(", ")}`);
    out.push(`- Before the fix: ${base && typeof base.fail === "number" ? `${base.fail} failing, ${base.pass ?? 0} passing on base` : "not recorded"}; after: ${after.length > 0 ? after.map((c) => c.result).join(", ") : "not recorded"}`);
  }
  return out;
}
export function renderReviewerBody(i: ReviewerBodyInput): string {
  const task = typeof i.outputs.intake?.["task"] === "string" ? (i.outputs.intake["task"] as string) : "";
  const title = typeof i.outputs.intake?.["title"] === "string" ? (i.outputs.intake["title"] as string) : "";
  const changed = arr<string>(i.outputs.verify?.["changed_files"]), planned = arr<string>(i.outputs.plan?.["relevant_files"]);
  const files = changed.length > 0 ? changed : planned, planText = i.outputs.plan?.["plan"];
  const why = title || (task.split("\n")[0] ?? "") || (typeof planText === "string" ? (planText.split("\n").find((l) => l.trim()) ?? "") : "");
  const L = ["## What the issue asked", ...(task ? criteria(task).map((c) => `- ${c}`) : ["- not recorded"]), ""];
  L.push("## What changed and why", `- Why: ${why ? clip(why) : "not recorded"}`);
  L.push(...(files.length > 0 ? more(files.map((f) => `- ${f}`), MAX_FILES) : ["- Files in scope: not recorded"]), "");
  L.push("## How it was tested", `- Verdict: ${i.verdict}${i.draftReason ? ` (DRAFT: ${i.draftReason})` : ""}`, ...tested(i.outputs), "");
  L.push("## NOT PROVEN", ...(i.notProven.length > 0 ? i.notProven.map((p) => `- ${p}`) : ["- none"]), "");
  L.push("## Receipt", `- Digest: ${i.receiptSha256 ? `sha256:${i.receiptSha256}` : "not recorded"}${i.signed === null ? "" : i.signed ? " (signed)" : " (UNSIGNED)"}`);
  if (i.receiptPath) L.push(`- File: ${i.receiptPath}`);
  L.push(`- Verify: \`loki verify ${i.runId}\``);
  return `${L.join("\n")}\n`;
}
