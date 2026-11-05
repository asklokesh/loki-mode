// False-positive replay of the no-regression differential on real fix commits from Go repos that are not in the benchmark
// corpus (fp/commits.json, chosen by fp/pick_commits.py before any model call). Each maintainer commit plays a correct fix:
// base is its parent, the patched tree is the parent plus the commit's change to its one non-test Go file (the tests stay
// at base). A blocking finding on such a commit is a false positive. Usage:
//   bun fp.ts <commits.json> <repos-dir> <work-dir> haiku|replay [transcripts.json]
// <repos-dir> holds full clones named by each commit's `dir`. One batched probe call writes every commit's program and one
// batched judge call covers every changed keep case (an experiment economy; the product makes one call of each per run).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { extractProgram } from "../../../loki-ts/src/features/probes.ts";
import { callersOf, editedSymbols, nrdJudgePrompt, nrdProbePrompt, parseNrdVerdicts, probeContext, runNoRegression, SYS_NRD_JUDGE, type JudgeCase, type NrdContext, type NrdResult, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import type { LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { haikuCli, replayCalls, ZERO_USAGE, type Transcript } from "../haiku_cli.ts";
import { sh, treeIo } from "./tree_io.ts";

const [listArg, reposArg, workArg, mode, canned] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const repos = resolve(reposArg), work = resolve(workArg);
const commits = (JSON.parse(readFileSync(listArg, "utf8")) as { commits: { id: string; repo: string; dir: string; sha: string; file: string; issue: string }[] }).commits;
const env = { GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };
const transcripts: Transcript[] = [];
const llm: LlmCall = mode === "replay" ? replayCalls(canned!, transcripts) : haikuCli(work, transcripts, { effort: "low" });
mkdirSync(work, { recursive: true });
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });

interface Task { id: string; ctx: NrdContext; src: string; patch: string; pkg: string; edited: string[]; callers: string[]; skip?: string }
const tasks: Task[] = [];
for (const c of commits) {
  const clone = join(repos, c.dir), src = join(work, c.id, "src"), patch = join(work, c.id, "change.diff");
  mkdirSync(src, { recursive: true });
  execFileSync("sh", ["-c", `git -C "$1" archive "$2^" | tar -x -C "$3"`, "sh", clone, c.sha, src]);
  if (!existsSync(join(src, "go.mod"))) writeFileSync(join(src, "go.mod"), `module github.com/${c.repo}\n\ngo 1.21\n`); // a pre-modules commit: same go.mod on both sides
  writeFileSync(patch, git(clone, "diff", `${c.sha}^`, c.sha, "--", c.file));
  const base = git(clone, "show", `${c.sha}^:${c.file}`), after = git(clone, "show", `${c.sha}:${c.file}`);
  const pkg = /^package (\w+)/m.exec(base)![1]!, dir = c.file.includes("/") ? c.file.slice(0, c.file.lastIndexOf("/")) : ".";
  const pkgFiles: Record<string, string> = {}, testFiles: Record<string, string> = {};
  for (const f of readdirSync(join(src, dir)).filter((f) => f.endsWith(".go"))) (f.endsWith("_test.go") ? testFiles : pkgFiles)[dir === "." ? f : `${dir}/${f}`] = readFileSync(join(src, dir, f), "utf8");
  const edited = editedSymbols(c.file, base, after), callers = callersOf(edited, pkgFiles);
  const { files, tests } = probeContext(pkgFiles, testFiles, [...edited, ...callers], [c.file]);
  const warm = sh(src, "go", ["test", "-count=1", "-vet=off", "-run", "^$", `./${dir === "." ? "" : dir}`], env); // downloads modules once; vet off as in the probe run
  tasks.push({ id: c.id, ctx: { issue: c.issue, lang: "go", pkg, files, tests, edited, callers }, src, patch, pkg, edited, callers, ...(warm.ok ? {} : { skip: `base does not build: ${warm.out.slice(-300)}` }) });
}
const live = tasks.filter((t) => !t.skip);

// one batched probe call
const SYS_BATCH = "You write small behavioral probe programs. For each task output its header line, then one fenced code block, nothing else.";
const batchPrompt = [`There are ${live.length} independent tasks. Each is complete on its own; never mix code between them.`, ...live.map((t, i) => `=== TASK ${i + 1} ===\n${nrdProbePrompt(t.ctx)}`), "Output, for each task in order, the line === TASK <n> === followed by its one Go code block."].join("\n\n");
if (mode === "dry") { // no model call: what each task would send
  for (const t of tasks) console.log(t.id, t.skip ? `SKIP ${t.skip}` : `edited=${t.edited.join(",")} callers=${t.callers.length} files=${Object.keys(t.ctx.files).join(",")} tests=${Object.keys(t.ctx.tests).length} chars=${nrdProbePrompt(t.ctx).length}`);
  console.log("batched prompt chars", batchPrompt.length);
  writeFileSync(join(work, "batch-prompt.txt"), batchPrompt);
  process.exit(0);
}
const probeText = (await llm(SYS_BATCH, batchPrompt)).text;
const parts = probeText.split(/^=== TASK (\d+) ===\s*$/m), programs = new Map<string, string>();
for (let i = 1; i + 1 < parts.length; i += 2) { const t = live[Number(parts[i]) - 1]; if (t) programs.set(t.id, extractProgram(parts[i + 1]!)); }

// pass 1: every differential with the judge deferred
const noJudge: LlmCall = async (system, user) => (system === SYS_NRD_JUDGE ? { text: "", usage: ZERO_USAGE } : llm(system, user));
const trees = new Map(live.map((t) => [t.id, treeIo(t.src, join(work, t.id, "tree"), t.patch, { pkgDir: ".", pkg: t.pkg, env })]));
const pass1 = new Map<string, NrdResult>();
for (const t of live) if (programs.has(t.id)) pass1.set(t.id, await runNoRegression(t.ctx, noJudge, trees.get(t.id)!, { program: programs.get(t.id)! }));
// pass 2: one batched judge call over every changed keep case
const keyOf = (f: { id: string; before: string; after: string }): string => `${f.id}\u0000${f.before}\u0000${f.after}`;
const asks = new Map<string, (JudgeCase & { key: string })[]>(), verdicts = new Map<string, Map<string, Verdict>>();
for (const [id, r] of pass1) if (r.findings.length) asks.set(id, r.findings.map((f) => ({ key: keyOf(f), label: `T${live.findIndex((t) => t.id === id) + 1}-${f.id}`, desc: f.desc, before: f.before, after: f.after })));
if (asks.size) {
  const sections = [...asks].map(([id, cases]) => {
    const t = live.find((x) => x.id === id)!, r = pass1.get(id)!, n = live.indexOf(t) + 1;
    const requested = r.cases.filter((c) => c.status === "changed" && c.kind !== "keep").map((c) => ({ label: `T${n}-${c.id}`, desc: c.desc, before: c.before, after: c.after }));
    return `=== TASK ${n} ===\n${nrdJudgePrompt(t.ctx.issue, cases, requested)}`;
  });
  const v = parseNrdVerdicts((await llm(SYS_NRD_JUDGE, [`There are ${asks.size} independent tasks. Judge each case against its own task's issue only.`, ...sections, "Answer one line per case, with the case id exactly as written: <case id>: requested|unrequested|unknown"].join("\n\n"))).text);
  for (const [id, cases] of asks) verdicts.set(id, new Map(cases.map((c) => [c.key, v.get(c.label) ?? "unknown"])));
}
// pass 3: rescore with the verdicts, no further calls
const rows = [];
for (const t of tasks) {
  if (t.skip || !programs.has(t.id)) { rows.push({ id: t.id, skipped: t.skip ?? "no program in the batched reply" }); continue; }
  const r = await runNoRegression(t.ctx, noJudge, trees.get(t.id)!, { program: programs.get(t.id)!, verdicts: verdicts.get(t.id) ?? new Map() });
  rows.push({ id: t.id, edited: t.edited, callers: t.callers, cases: r.cases.length, fires: r.blocking.length > 0, blocking: r.blocking, findings: r.findings.map((f) => ({ id: f.id, verdict: f.verdict, desc: f.desc, before: f.before, after: f.after })), changedChange: r.cases.filter((c) => c.status === "changed" && c.kind !== "keep").map((c) => c.id), flaky: r.cases.filter((c) => c.status === "flaky").map((c) => c.id), missing: r.cases.filter((c) => c.status.startsWith("missing")).map((c) => `${c.id}:${c.status}`), notes: r.notes, program: r.program });
}
const total = transcripts.reduce((a, x) => ({ inTok: a.inTok + x.usage.inTok, outTok: a.outTok + x.usage.outTok, cacheRead: a.cacheRead + x.usage.cacheRead, cacheWrite: a.cacheWrite + x.usage.cacheWrite, costUsd: a.costUsd + x.usage.costUsd }), ZERO_USAGE);
const scored = rows.filter((r) => !("skipped" in r)) as { fires: boolean; findings: unknown[] }[];
const summary = { mode, commits: tasks.length, scored: scored.length, false_fires: `${scored.filter((r) => r.fires).length}/${scored.length}`, with_changed_keep_case: `${scored.filter((r) => r.findings.length > 0).length}/${scored.length}`, calls: transcripts.length, total };
writeFileSync(join(work, "fp-report.json"), JSON.stringify({ summary, rows }, null, 2));
writeFileSync(join(work, "fp-transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ summary, rows: rows.map((r) => ("skipped" in r ? r : { id: r.id, edited: r.edited, cases: r.cases, fires: r.fires, findings: r.findings.map((f) => `${f.id}:${f.verdict}`), changedChange: r.changedChange, flaky: r.flaky, missing: r.missing })) }, null, 1));
