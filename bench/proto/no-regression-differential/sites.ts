// Round 3 driver: the no-regression differential with the mechanical output-site ledger (outputSites) and the edge-value
// rule (edgeAdvisory). Part A reruns the gitlog fixture with each variant's own edited set (what a real run knows from its
// diff); part B reruns the 7 real maintainer commits (false fires) and their 25 unrelated-string mutants (recall), where a
// commit's program is written for its edited set plus the functions its mutants touch (the mutated literal is never named).
// Calls: one batched probe call for A, two for B, one batched judge call each. Usage:
//   bun sites.ts <work-dir> <repos-dir> haiku|replay|dry [transcripts.json]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { extractProgram, runGoProbe, type ProbeExec } from "../../../loki-ts/src/features/probes.ts";
import { callersOf, overrideVerdict, editedSymbols, nrdJudgePrompt, nrdProbePrompt, outputSites, parseNrdVerdicts, probeContext, runNoRegression, SYS_NRD_JUDGE, type NrdContext, type NrdIo, type NrdResult, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import type { LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { haikuCli, replayCalls, ZERO_USAGE, type Transcript } from "../haiku_cli.ts";
import { literalSites, sh, treeIo } from "./tree_io.ts";

const [workArg, reposArg, mode, canned] = process.argv.slice(2) as [string, string, string, string | undefined];
const work = resolve(workArg), repos = resolve(reposArg), here = import.meta.dir;
mkdirSync(work, { recursive: true });
const transcripts: Transcript[] = [];
const llm: LlmCall = mode === "replay" ? replayCalls(canned!, transcripts) : haikuCli(work, transcripts, { effort: "low", timeoutMs: 900_000 });
const noJudge: LlmCall = async (system, user) => { if (system === SYS_NRD_JUDGE) return { text: "", usage: ZERO_USAGE }; return llm(system, user); };
const keyOf = (f: { id: string; before: string; after: string }): string => `${f.id}\u0000${f.before}\u0000${f.after}`;
const SYS_BATCH = "You write small behavioral probe programs. For each task output its header line, then one fenced code block, nothing else.";
async function probeBatch(ctxs: NrdContext[]): Promise<string[]> {
  const prompt = [`There are ${ctxs.length} independent tasks. Each is complete on its own; never mix code between them.`, ...ctxs.map((c, i) => `=== TASK ${i + 1} ===\n${nrdProbePrompt(c)}`), "Output, for each task in order, the line === TASK <n> === followed by its one Go code block."].join("\n\n");
  if (mode === "dry") { writeFileSync(join(work, `batch-${ctxs.length}-${Date.now()}.txt`), prompt); return ctxs.map(() => ""); }
  const parts = (await llm(SYS_BATCH, prompt)).text.split(/^=== TASK (\d+) ===\s*$/m), out: string[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) out[Number(parts[i]) - 1] = extractProgram(parts[i + 1]!);
  return out;
}
/** One batched judge call: `asks` maps a section label to [issue, cases]. */
async function judgeBatch(asks: { tag: string; issue: string; cases: { id: string; desc: string; before: string; after: string }[] }[]): Promise<Map<string, Verdict>> {
  const v = new Map<string, Verdict>();
  const live = asks.filter((a) => a.cases.length);
  if (!live.length || mode === "dry") return v;
  const text = (await llm(SYS_NRD_JUDGE, [`There are ${live.length} independent tasks. Judge each case against its own task's issue only.`, ...live.map((a, n) => `=== TASK ${n + 1} ===\n${nrdJudgePrompt(a.issue, a.cases.map((c) => ({ label: `${a.tag}-${c.id}`, desc: c.desc, before: c.before, after: c.after })))}`), "Answer one line per case, with the case id exactly as written: <case id>: requested|unrequested|unknown"].join("\n\n"))).text;
  const got = parseNrdVerdicts(text);
  for (const a of live) for (const c of a.cases) v.set(`${a.tag}\u0000${keyOf(c)}`, got.get(`${a.tag}-${c.id}`) ?? "unknown");
  return v;
}
const verdictsFor = (all: Map<string, Verdict>, tag: string): Map<string, Verdict> => new Map([...all].filter(([k]) => k.startsWith(`${tag}\u0000`)).map(([k, x]) => [k.slice(tag.length + 1), x]));

// ---- part A: gitlog fixture, every variant with its own edited set ----
const fx = join(here, "fixtures", "gitlog"), repoA = join(fx, "repo"), pkgDir = "changelog";
const filesA: Record<string, string> = {}, testsA: Record<string, string> = {};
for (const f of readdirSync(join(repoA, pkgDir)).filter((f) => f.endsWith(".go"))) (f.endsWith("_test.go") ? testsA : filesA)[`${pkgDir}/${f}`] = readFileSync(join(repoA, pkgDir, f), "utf8");
const issueA = readFileSync(join(fx, "issue.md"), "utf8");
const variants = readdirSync(join(fx, "variants")).filter((f) => f.endsWith(".patch") && (mode !== "replay" || !f.includes("-edit-test"))).map((f) => f.replace(/\.patch$/, "")).sort(); // replay: the 6 variants the recorded run had (the edit-test ones came in round 4)
const A = variants.map((v) => {
  const io = treeIo(repoA, join(work, "A", v), join(fx, "variants", `${v}.patch`), { pkgDir, pkg: "changelog" });
  sh(io.dir, "git", ["apply", "-p1", join(fx, "variants", `${v}.patch`)]);
  const after = readFileSync(join(io.dir, pkgDir, "changelog.go"), "utf8");
  sh(io.dir, "git", ["apply", "-R", "-p1", join(fx, "variants", `${v}.patch`)]);
  const edited = editedSymbols("changelog/changelog.go", filesA["changelog/changelog.go"]!, after), callers = callersOf(edited, filesA);
  const ctx: NrdContext = { issue: issueA, lang: "go", pkg: "changelog", files: filesA, tests: testsA, edited, callers, sites: outputSites(filesA, [...edited, ...callers]), repoTests: testsA };
  return { v, io, ctx };
});

// ---- part B: real commits, plus their mutants' functions ----
const commits = (JSON.parse(readFileSync(join(here, "fp", "commits.json"), "utf8")) as { commits: { id: string; repo: string; dir: string; sha: string; file: string; issue: string }[] }).commits;
const env = { GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const B = commits.map((c) => {
  const clone = join(repos, c.dir), dir = join(work, "B", c.id);
  mkdirSync(dir, { recursive: true });
  execFileSync("sh", ["-c", `git -C "$1" archive "$2^" | tar -x -C "$3"`, "sh", clone, c.sha, dir]);
  if (!existsSync(join(dir, "go.mod"))) writeFileSync(join(dir, "go.mod"), `module github.com/${c.repo}\n\ngo 1.21\n`);
  const base = git(clone, "show", `${c.sha}^:${c.file}`), patched = git(clone, "show", `${c.sha}:${c.file}`);
  const pkg = /^package (\w+)/m.exec(base)![1]!, sub = c.file.includes("/") ? c.file.slice(0, c.file.lastIndexOf("/")) : ".";
  const pkgFiles: Record<string, string> = {}, testFiles: Record<string, string> = {};
  for (const f of readdirSync(join(dir, sub)).filter((f) => f.endsWith(".go"))) (f.endsWith("_test.go") ? testFiles : pkgFiles)[sub === "." ? f : `${sub}/${f}`] = readFileSync(join(dir, sub, f), "utf8");
  const edited = editedSymbols(c.file, base, patched);
  const all = literalSites(c.file, patched, edited), step = Math.max(1, Math.ceil(all.length / 8)), mutants = all.filter((_, i) => i % step === 0).slice(0, 8); // mutants.ts's selection, cap 8
  const names = [...new Set([...edited, ...mutants.map((m) => m.fn)])], callers = callersOf(names, pkgFiles);
  const { files, tests } = probeContext(pkgFiles, testFiles, [...names, ...callers], [c.file]);
  const ctx: NrdContext = { issue: c.issue, lang: "go", pkg, files, tests, edited: names, callers, sites: outputSites(pkgFiles, [...names, ...callers]), repoTests: testFiles };
  return { c, dir, base, patched, pkg, ctx, mutants, sub };
});

if (mode === "dry") {
  for (const a of A) console.log("A", a.v, "edited", a.ctx.edited, "sites", a.ctx.sites!.map((s) => `${s.id} ${s.fn}: ${s.text}`));
  for (const b of B) console.log("B", b.c.id, "edited", b.ctx.edited, "sites", b.ctx.sites!.length, "mutants", b.mutants.length);
}
const progA = await probeBatch(A.map((a) => a.ctx));
const progB = [...(await probeBatch(B.slice(0, 4).map((b) => b.ctx))), ...(await probeBatch(B.slice(4).map((b) => b.ctx)))];
if (mode === "dry") process.exit(0);

// pass 1 (no judge)
const p1A = new Map<string, NrdResult>();
for (const [i, a] of A.entries()) if (progA[i]) p1A.set(a.v, await runNoRegression(a.ctx, noJudge, a.io, { program: progA[i] }));
type Mut = { fn: string; literal: string; own: boolean; r: NrdResult };
const p1B = new Map<string, { ref: NrdResult; muts: Mut[]; refOwnPass: boolean }>();
for (const [i, b] of B.entries()) {
  const program = progB[i]; if (!program) continue;
  const file = join(b.dir, b.c.file); let lastBase: { p: string; e: ProbeExec } | null = null;
  const ioFor = (text: string, reuse: boolean): NrdIo => ({ run(state, p) {
    if (state === "base" && reuse && lastBase && lastBase.p === p) return { ...lastBase.e, roots: [b.dir] };
    writeFileSync(file, state === "base" ? b.base : text);
    const e = runGoProbe({ moduleRoot: b.dir, pkgDir: b.sub, pkg: b.pkg, program: p, env }); if (state === "base") lastBase = { p, e };
    return { ...e, roots: [b.dir] };
  } });
  const ref = await runNoRegression(b.ctx, noJudge, ioFor(b.patched, false), { program });
  writeFileSync(file, b.patched); const refOwnPass = sh(b.dir, "go", ["test", "-count=1", "-vet=off", `./${b.sub === "." ? "" : b.sub}`], env).ok;
  const muts: Mut[] = [];
  for (const m of b.mutants) {
    const text = b.patched.slice(0, m.end) + "_m" + b.patched.slice(m.end);
    writeFileSync(file, text); const own = !sh(b.dir, "go", ["test", "-count=1", "-vet=off", `./${b.sub === "." ? "" : b.sub}`], env).ok;
    muts.push({ fn: m.fn, literal: m.text.slice(0, 50), own, r: await runNoRegression(b.ctx, noJudge, ioFor(text, true), { program: ref.program }) });
  }
  writeFileSync(file, b.base);
  p1B.set(b.c.id, { ref, muts, refOwnPass });
}
// pass 2: judges (A: one call; B: one call over the references and the surviving mutants)
const vA = await judgeBatch(A.filter((a) => p1A.has(a.v)).map((a) => ({ tag: a.v, issue: issueA, cases: dedupe(p1A.get(a.v)!.findings) })));
const asksB: { tag: string; issue: string; cases: { id: string; desc: string; before: string; after: string }[] }[] = [];
for (const b of B) { const x = p1B.get(b.c.id); if (!x) continue; asksB.push({ tag: b.c.id, issue: b.c.issue, cases: dedupe([...x.ref.findings, ...x.muts.filter((m) => !m.own).flatMap((m) => m.r.findings)]) }); }
const vB = await judgeBatch(asksB);
function dedupe<T extends { id: string; before: string; after: string }>(xs: T[]): T[] { const seen = new Set<string>(); return xs.filter((x) => !seen.has(keyOf(x)) && !!seen.add(keyOf(x))); }

// pass 3: rescore with verdicts (no calls)
const rowsA = [];
for (const [i, a] of A.entries()) {
  if (!progA[i]) { rowsA.push({ variant: a.v, skipped: "no program" }); continue; }
  const r = await runNoRegression(a.ctx, noJudge, a.io, { program: progA[i], verdicts: verdictsFor(vA, a.v) });
  rowsA.push({ variant: a.v, edited: a.ctx.edited, sites: a.ctx.sites!.length, uncovered: r.uncovered, oracle: a.io.oracle(join(fx, "oracle", "oracle_test.go"), "Oracle"), fires: r.blocking.length > 0, blocking: r.blocking.map((f) => `${f.id}: ${f.desc}`), findings: r.findings.map((f) => `${f.id}:${f.verdict}`), advisory: r.advisory, cases: r.cases.length });
}
const rowsB = [];
for (const b of B) {
  const x = p1B.get(b.c.id); if (!x) { rowsB.push({ id: b.c.id, skipped: "no program" }); continue; }
  const v = verdictsFor(vB, b.c.id), refKeys = new Set(x.ref.findings.map(keyOf));
  const rescore = (r: NrdResult) => { const f = r.findings.map((y) => ({ ...y, verdict: overrideVerdict(b.c.issue, y, v.get(keyOf(y)) ?? "unknown") })); return f; };
  const refF = rescore(x.ref), refBlocking = refF.filter((f) => f.verdict === "unrequested" && !(x.ref.advisory ?? []).includes(f.id));
  // edge rule is decided by runNoRegression only when verdicts are present; recompute it here through a verdict-carrying rerun-free path
  const { edgeAdvisory } = await import("../../../loki-ts/src/features/no_regression.ts"), { caseSnippet } = await import("../../../loki-ts/src/features/probes.ts");
  const refBlock = refBlocking.filter((f) => !edgeAdvisory(caseSnippet(x.ref.program, f.id), f.desc, b.ctx.repoTests));
  const muts = x.muts.map((m) => { const f = rescore(m.r).filter((y) => !refKeys.has(keyOf(y))); return { fn: m.fn, literal: m.literal, own: m.own, keepChanged: f.map((y) => y.id), blocking: f.filter((y) => y.verdict === "unrequested" && !edgeAdvisory(caseSnippet(x.ref.program, y.id), y.desc, b.ctx.repoTests)).map((y) => y.id) }; });
  rowsB.push({ id: b.c.id, refOwnPass: x.refOwnPass, cases: x.ref.cases.length, sites: b.ctx.sites!.length, uncovered: x.ref.uncovered, fires: refBlock.length > 0, refFindings: refF.map((f) => `${f.id}:${f.verdict}: ${f.desc} | ${f.before.slice(0, 50)} -> ${f.after.slice(0, 50)}`), edgeAdvisory: refBlocking.filter((f) => !refBlock.includes(f)).map((f) => f.id), mutants: muts });
}
const okA = rowsA.filter((r) => !("skipped" in r)) as { variant: string; fires: boolean; oracle: boolean }[];
const okB = rowsB.filter((r) => !("skipped" in r)) as { fires: boolean; mutants: { own: boolean; keepChanged: string[]; blocking: string[] }[] }[];
const surv = okB.flatMap((r) => r.mutants.filter((m) => !m.own));
const total = transcripts.reduce((a, t) => ({ inTok: a.inTok + t.usage.inTok, outTok: a.outTok + t.usage.outTok, cacheRead: a.cacheRead + t.usage.cacheRead, cacheWrite: a.cacheWrite + t.usage.cacheWrite, costUsd: a.costUsd + t.usage.costUsd }), ZERO_USAGE);
const summary = {
  mode, calls: transcripts.length, total,
  gitlog: { caught: `${okA.filter((r) => r.variant.startsWith("regress") && r.fires).length}/${okA.filter((r) => r.variant.startsWith("regress")).length}`, false_fires: `${okA.filter((r) => r.variant.startsWith("correct") && r.fires).length}/${okA.filter((r) => r.variant.startsWith("correct")).length}`, fires_iff_oracle_fails: `${okA.filter((r) => r.oracle === !r.fires).length}/${okA.length}` },
  commits: { scored: okB.length, false_fires: `${okB.filter((r) => r.fires).length}/${okB.length}`, mutants: okB.reduce((a, r) => a + r.mutants.length, 0), survivors: surv.length, survivorsSeen: surv.filter((m) => m.keepChanged.length).length, survivorsBlocking: surv.filter((m) => m.blocking.length).length },
};
writeFileSync(join(work, "sites-report.json"), JSON.stringify({ summary, rowsA, rowsB, programsA: progA, programsB: progB }, null, 2));
writeFileSync(join(work, "sites-transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ summary, rowsA, rowsB: rowsB.map((r) => ("skipped" in r ? r : { ...r, mutants: (r as { mutants: unknown[] }).mutants })) }, null, 1));
