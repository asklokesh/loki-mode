// INTEL-3: reviewer-first PR body, pure rendering from data the engine already holds. Order: what was asked, what changed, how it was tested, NOT PROVEN, receipt. Absent data
// prints "not recorded", never a number. Task text is untrusted: truncated, never executed.
import { noteOf } from "../util/base_guard.ts";
import { getVersion } from "../version.ts"; import { SEAL_ACCURACY_NOT_MEASURED } from "../util/run_outputs.ts";
import { ALREADY_FAILING_ON_BASE, checkResultLabel } from "../util/check_result.ts"; import { intentLine, stripTemplate } from "../util/intent_card.ts"; import { WALL_FILE } from "./commit_filter.ts";
export interface ReviewerBodyInput {
  verdict: string; draftReason: string | null; notProven: string[];
  receiptPath: string | null; receiptSha256: string | null; signed: boolean | null; runId: string;
  outputs: Partial<Record<string, Record<string, unknown>>>; sealAccuracy?: string; // the receipt's signed accuracy line (GAME10-03c)
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
  const kept = stripTemplate(task.split("\n").map((l) => l.trim()).filter(Boolean)), lines = acceptance(kept); if (kept.every((l) => /^#+\s/.test(l))) return []; // nothing but template text was left
  const items = lines.filter((l) => /^([-*+]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?/, ""));
  return more((items.length > 0 ? items : lines.slice(0, 1)).map(clip), MAX_CRITERIA);
}
function tested(o: ReviewerBodyInput["outputs"]): string[] {
  if (!o.verify) return ["- Tests: not recorded"];
  const checks = arr<{ name: string; cmd: string; result: string; n?: number }>(o.verify["checks"]);
  const by = (r: string): number => checks.filter((c) => c.result === r).length;
  const ran = checks.reduce((n, c) => n + (typeof c.n === "number" ? c.n : 0), 0);
  const preRed = new Set(arr<string>(o.verify["pre_red_checks"])), red = (c: { name: string; result: string }): boolean => c.result === "fail" && preRed.has(c.name), onBase = checks.filter(red).length, out = [`- Checks: ${by("pass")} passed, ${by("fail") - onBase} failed, ${by("not_run")} not run, ${by("flaky")} flaky${ran > 0 ? ` (${ran} individual tests counted)` : ""}${onBase > 0 ? `; ${onBase} ${ALREADY_FAILING_ON_BASE.split(",")[0]}` : ""}`];
  out.push(...more(checks.map((c) => `- Command: \`${clip(c.cmd)}\` -> ${checkResultLabel(c.result, red(c))}`), MAX_CMDS));
  const base = o.wall?.["base_run"] as { fail?: number; pass?: number } | undefined;
  const wfiles = arr<{ path: string }>(o.wall?.["files"]).map((f) => f.path.split("/").pop() ?? f.path);
  if (wfiles.length > 0) {
    const after = checks.filter((c) => wfiles.some((f) => c.name.endsWith(f)));
    out.push(`- Target tests (written before the fix): ${wfiles.join(", ")}`);
    out.push(`- Before the fix: ${base && typeof base.fail === "number" ? `${base.fail} failing, ${base.pass ?? 0} passing on base` : "not recorded"}; after: ${after.length > 0 ? after.map((c) => c.result).join(", ") : "not recorded"}`);
  }
  return out;
}
export function renderReviewerBody(i: ReviewerBodyInput, env: NodeJS.ProcessEnv = process.env, version: string = getVersion()): string {
  const task = typeof i.outputs.intake?.["task"] === "string" ? (i.outputs.intake["task"] as string) : "", title = typeof i.outputs.intake?.["title"] === "string" ? (i.outputs.intake["title"] as string) : "";
  const changed = arr<string>(i.outputs.verify?.["changed_files"]).filter((f) => !WALL_FILE.test(f)), /* the commit stage drops Wall files, so they are not in the diff */ planned = arr<string>(i.outputs.plan?.["relevant_files"]);
  const files = changed.length > 0 ? changed.map((f) => `- ${f}`) : planned.length > 0 ? [`- Files in scope (planned, no diff recorded): ${planned.slice(0, MAX_FILES).join(", ")}${planned.length > MAX_FILES ? ` (+${planned.length - MAX_FILES} more)` : ""}`] : [], planText = i.outputs.plan?.["plan"];
  const why = title || (task.split("\n")[0] ?? "") || (typeof planText === "string" ? (planText.split("\n").find((l) => l.trim()) ?? "") : "");
  const il = intentLine(i.outputs.plan?.["intent_card"]), cr = task ? criteria(task).map((c) => `- ${c}`) : [], asked = cr.length > 0 ? cr : il ? [`- ${clip(il)}`] : []; // the intent line stands in only when the issue left nothing but template text
  const np = i.verdict === "PARTIAL" ? i.notProven.filter((r) => r.trim() !== "") : [], npHead = np.length > 0 ? ["## Not proven", `This run sealed PARTIAL: ${np.length} thing${np.length === 1 ? " is" : "s are"} not proven. Opened as a draft so the work is reviewable.`, ...np.slice(0, 10).map((r) => `- ${clip(r)}`), ...(np.length > 10 ? [`- (+${np.length - 10} more, total ${np.length}; the full list is in the receipt)`] : []), ""] : []; // PR-FIRST-1: a PARTIAL PR says first what is unproven
  const L = [...npHead, "## What the issue asked", ...(asked.length > 0 ? asked : ["- not recorded"]), "", "## What changed and why", `- Why: ${why ? clip(why) : "not recorded"}`, ...(files.length > 0 ? more(files, MAX_FILES) : ["- Files in scope: not recorded"]), ""];
  L.push("## How it was tested", `- Verdict: ${i.verdict}${i.draftReason ? ` (DRAFT: ${i.draftReason})` : ""}`, ...(noteOf(i.outputs.intake) ? [`- Note: ${noteOf(i.outputs.intake)}`] : []), ...tested(i.outputs), ""); // FC-15: unclipped, the evidence paths are the point
  const wp = i.outputs.seal?.["wall_published"] as { files?: unknown; cmds?: unknown } | undefined; if (arr<string>(wp?.files).length > 0) L.push("## Acceptance tests", "Published in this branch: the Wall tests that ran and passed in verify.", ...arr<string>(wp?.files).map((f) => `- ${clip(f)}`), ...arr<string>(wp?.cmds).map((c) => `- Run: \`${clip(c)}\``), ""); /* FC-VERIFIED-PR-WITHOUT-ITS-TEST */ L.push("## NOT PROVEN", ...(i.notProven.length > 0 ? i.notProven.map((p) => `- ${p}`) : ["- none"]), "");
  L.push("## Receipt", `- Digest: ${i.receiptSha256 ? `sha256:${i.receiptSha256}` : "not recorded"}${i.signed === null ? "" : i.signed ? " (signed)" : " (UNSIGNED)"}`, `- ${i.sealAccuracy ?? SEAL_ACCURACY_NOT_MEASURED}`);
  const rel = /(?:^|\/)(\.loki\/runs\/[^/]+\/receipt\.json)$/.exec(i.receiptPath ?? "")?.[1]; if (rel) L.push(`- File: ${rel}`); // repo-relative only: an absolute local path never goes into a public PR
  L.push(`- Verify: \`loki verify ${i.runId}\``);
  L.push(`- On another machine: the author runs \`loki proof bundle ${i.runId}\`; the reviewer runs \`loki verify --pubkey pubkey.jwk receipt.json\`${/^\d+\.\d+\.\d+/.test(version) ? " or adds this step to a workflow:" : " or adds the receipt-check action"}`);
  if (/^\d+\.\d+\.\d+/.test(version)) L.push(`- \`uses: asklokesh/loki-mode/.github/actions/receipt-check@v${version}\``);
  if (env["LOKI_PR_FOOTER"] !== "0") L.push("", `${i.verdict === "VERIFIED" && !i.draftReason ? "Built and verified with" : "Built with"} Loki Mode: https://github.com/asklokesh/loki-mode`); // static text, no network call, no telemetry
  return `${L.join("\n")}\n`;
}
