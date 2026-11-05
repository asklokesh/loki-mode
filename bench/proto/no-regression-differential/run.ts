// Experiment driver for the no-regression differential prototype. Usage:
//   bun run.ts <fixture-dir> <work-dir> stub|haiku|replay [transcripts.json]
// <fixture-dir> holds repo/ (the base tree, one Go package), issue.md, variants/*.patch (candidate fixes, -p1 against repo/),
// and oracle/oracle_test.go, which plays the maintainer's hidden test: it is scored only after the differential has run
// and is never shown to any prompt. <work-dir> must be a fresh directory; every scratch tree goes under it.
//
// One probe program is written per fixture from the issue and the base code only and reused for every variant, so it cannot
// be fitted to any one patch. The judge call covers the distinct changed keep cases of all variants at once: an experiment
// economy, since in the product each run asks only about its own cases.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { nrdJudgePrompt, parseNrdVerdicts, runNoRegression, SYS_NRD_JUDGE, type JudgeCase, type NrdContext, type NrdResult, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import { buildFixBrief } from "../../../loki-ts/src/engine10/stages/fix.ts";
import type { LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { haikuCli, replayCalls, ZERO_USAGE, type Transcript } from "../haiku_cli.ts";
import { treeIo } from "./tree_io.ts";

const [fixtureArg, workArg, mode, canned] = process.argv.slice(2) as [string, string, string, string | undefined];
const fixture = resolve(fixtureArg), work = resolve(workArg);
const repo = join(fixture, "repo");
const pkgDir = readdirSync(repo).find((n) => statSync(join(repo, n)).isDirectory() && readdirSync(join(repo, n)).some((f) => f.endsWith(".go")))!;
const files: Record<string, string> = {}, tests: Record<string, string> = {};
for (const f of readdirSync(join(repo, pkgDir)).filter((f) => f.endsWith(".go"))) (f.endsWith("_test.go") ? tests : files)[`${pkgDir}/${f}`] = readFileSync(join(repo, pkgDir, f), "utf8");
const pkg = /^package (\w+)/m.exec(Object.values(files)[0]!)![1]!;
const issue = readFileSync(join(fixture, "issue.md"), "utf8");
const ctx: NrdContext = { issue, lang: "go", pkg, files, tests };
const variants = ["base", ...readdirSync(join(fixture, "variants")).filter((f) => f.endsWith(".patch")).map((f) => basename(f, ".patch")).sort()];

const transcripts: Transcript[] = [];
let llm: LlmCall;
if (mode === "stub") {
  // stand-in model: the fixture's hand-written probe program, and a judge answering from a canned map
  const program = readFileSync(join(fixture, "stub", "probe.go.txt"), "utf8"), truth = JSON.parse(readFileSync(join(fixture, "stub", "verdicts.json"), "utf8")) as Record<string, Verdict>;
  llm = async (system, user) => {
    const text = system !== SYS_NRD_JUDGE ? "```go\n" + program + "```" : [...user.matchAll(/^CASE (\S+):/gm)].map((m) => `${m[1]}: ${truth[m[1]!.split("#")[0]!] ?? "unknown"}`).join("\n");
    transcripts.push({ system, user, text, usage: ZERO_USAGE });
    return { text, usage: ZERO_USAGE };
  };
} else if (mode === "replay") llm = replayCalls(canned!, transcripts);
else llm = haikuCli(work, transcripts, { effort: "low" });

mkdirSync(work, { recursive: true });
const io = (v: string) => treeIo(repo, join(work, v), variants.includes(v) && v !== "base" ? join(fixture, "variants", `${v}.patch`) : null, { pkgDir, pkg });
// The judge is deferred: pass 1 records every variant's changed keep cases (no judge call), pass 2 asks one judge call about
// the distinct ones, pass 3 rescores every variant with those verdicts and the same program, with no further calls.
const noJudge: LlmCall = async (system, user) => (system === SYS_NRD_JUDGE ? { text: "", usage: ZERO_USAGE } : llm(system, user));
const first = await runNoRegression(ctx, noJudge, io("probe-writer"));
const program = first.program;
const trees = new Map(variants.map((v) => [v, io(v)]));
const pass1 = new Map<string, NrdResult>();
for (const v of variants) pass1.set(v, await runNoRegression(ctx, noJudge, trees.get(v)!, { program }));
const keyOf = (f: { id: string; before: string; after: string }): string => `${f.id}\u0000${f.before}\u0000${f.after}`;
const asked: (JudgeCase & { key: string })[] = [], reference: JudgeCase[] = [];
for (const r of pass1.values()) {
  for (const f of r.findings) {
    if (asked.some((a) => a.key === keyOf(f))) continue;
    const n = asked.filter((a) => a.label.split("#")[0] === f.id).length;
    asked.push({ key: keyOf(f), label: n ? `${f.id}#${n + 1}` : f.id, desc: f.desc, before: f.before, after: f.after });
  }
  for (const c of r.cases) if (c.status === "changed" && c.kind !== "keep" && !reference.some((q) => q.label === c.id && q.after === c.after)) reference.push({ label: c.id, desc: c.desc, before: c.before, after: c.after });
}
const verdicts = new Map<string, Verdict>();
if (asked.length) {
  const j = await llm(SYS_NRD_JUDGE, nrdJudgePrompt(issue, asked, reference.slice(0, 3)));
  const v = parseNrdVerdicts(j.text);
  for (const a of asked) verdicts.set(a.key, v.get(a.label) ?? "unknown");
}
const rows = [];
for (const v of variants) {
  const r = await runNoRegression(ctx, noJudge, trees.get(v)!, { program, verdicts }); // every changed keep case already has a verdict: no call
  const oracle = v === "base" ? null : trees.get(v)!.oracle(join(fixture, "oracle", "oracle_test.go"), "Oracle");
  if (r.blocking.length) writeFileSync(join(work, `${v}-fix-brief.txt`), buildFixBrief(issue, r.groups, "(the run's diff goes here)"));
  rows.push({ variant: v, oracle, fires: r.blocking.length > 0, calls: r.calls, blocking: r.blocking.map((f) => ({ id: f.id, desc: f.desc, before: f.before, after: f.after })), findings: r.findings.map((f) => `${f.id}:${f.verdict}`), changed: r.cases.filter((c) => c.status === "changed").map((c) => `${c.id}(${c.kind})`), flaky: r.cases.filter((c) => c.status === "flaky").map((c) => c.id), missing: r.cases.filter((c) => c.status.startsWith("missing")).map((c) => `${c.id}:${c.status}`), notes: r.notes });
}
const total = transcripts.reduce((a, t) => ({ inTok: a.inTok + t.usage.inTok, outTok: a.outTok + t.usage.outTok, cacheRead: a.cacheRead + t.usage.cacheRead, cacheWrite: a.cacheWrite + t.usage.cacheWrite, costUsd: a.costUsd + t.usage.costUsd }), ZERO_USAGE);
const regress = rows.filter((r) => r.variant.startsWith("regress")), correct = rows.filter((r) => r.variant.startsWith("correct"));
const scored = rows.filter((r) => r.oracle !== null);
const summary = {
  fixture: basename(fixture), mode, cases: first.cases.length, calls: transcripts.length, total,
  caught: `${regress.filter((r) => r.fires).length}/${regress.length}`, false_fires: `${correct.filter((r) => r.fires).length}/${correct.length}`,
  base_fires: rows.find((r) => r.variant === "base")!.fires, fires_iff_oracle_fails: `${scored.filter((r) => r.oracle === !r.fires).length}/${scored.length}`,
};
writeFileSync(join(work, "report.json"), JSON.stringify({ summary, rows, program, judged: asked.map(({ key: _k, ...a }) => ({ ...a, verdict: verdicts.get(_k) })) }, null, 2));
writeFileSync(join(work, "transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ summary, rows: rows.map((r) => ({ variant: r.variant, oracle: r.oracle, fires: r.fires, findings: r.findings, changed: r.changed, flaky: r.flaky, missing: r.missing })) }, null, 1));
