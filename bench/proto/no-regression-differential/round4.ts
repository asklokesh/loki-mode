// Round 4 (judge round 2, items a-c): (a) zero-call BASE-TEST REPLAY: the original version of every existing test file the
// patch edited runs against the patched code in a scratch tree; a test that passed on base and fails now goes to the
// code-blind judge. (b) keep cases written BEFORE implement (what exec-spec's single pre-implement call would carry): the
// probe writer sees the issue, the base code and only the functions the ISSUE names (plus callers and the output-site
// ledger), never the diff. One batched judge call covers every finding. Usage:
//   bun round4.ts <work-dir> <repos-dir> haiku|dry
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { callersOf, overrideVerdict, nrdJudgePrompt, outputSites, parseNrdVerdicts, runNoRegression, SYS_NRD_JUDGE, SYS_NRD_PROBE, nrdProbePrompt, type NrdContext, type NrdResult, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import { extractProgram } from "../../../loki-ts/src/features/probes.ts";
import type { LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { haikuCli, replayCalls, ZERO_USAGE, type Transcript } from "../haiku_cli.ts";
import { treeIo } from "./tree_io.ts";

const [workArg, reposArg, mode, canned] = process.argv.slice(2) as [string, string, string, string | undefined];
const work = resolve(workArg), repos = resolve(reposArg), here = import.meta.dir;
mkdirSync(work, { recursive: true });
const transcripts: Transcript[] = [];
const llm: LlmCall = mode === "replay" ? replayCalls(canned!, transcripts) : haikuCli(work, transcripts, { effort: "low", timeoutMs: 900_000 });
const noJudge: LlmCall = async (s, u) => (s === SYS_NRD_JUDGE ? { text: "", usage: ZERO_USAGE } : llm(s, u));
const goEnv = { ...process.env, GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };

// ---- (a) base-test replay ----
interface ReplayFinding { id: string; desc: string; before: string; after: string }
function goTests(dir: string, pkg: string): Map<string, { ok: boolean; out: string }> {
  const r = spawnSync("go", ["test", "-count=1", "-vet=off", "-json", `./${pkg === "." ? "" : pkg}`], { cwd: dir, encoding: "utf8", env: goEnv, timeout: 300_000 });
  const res = new Map<string, { ok: boolean; out: string }>(), outs = new Map<string, string[]>();
  for (const l of (r.stdout ?? "").split("\n")) { try { const e = JSON.parse(l) as { Action: string; Test?: string; Output?: string }; if (!e.Test || e.Test.includes("/")) continue; if (e.Action === "output") outs.set(e.Test, [...(outs.get(e.Test) ?? []), e.Output ?? ""]); if (e.Action === "pass" || e.Action === "fail") res.set(e.Test, { ok: e.Action === "pass", out: (outs.get(e.Test) ?? []).filter((x) => !/^(=== RUN|--- (FAIL|PASS))/.test(x.trim())).join("").trim().slice(0, 300) }); } catch { /* not json */ } }
  return res;
}
/** `base` and `patched` are scratch trees; `editedTests` the repo-relative test files the patch changed (they are restored to base in a copy of patched). */
export function baseTestReplay(base: string, patched: string, editedTests: string[], pkg: string, scratch: string): { findings: ReplayFinding[]; ran: number } {
  if (!editedTests.length) return { findings: [], ran: 0 };
  cpSync(patched, scratch, { recursive: true });
  for (const f of editedTests) { if (existsSync(join(base, f))) cpSync(join(base, f), join(scratch, f)); }
  const b = goTests(base, pkg), now = goTests(scratch, pkg), findings: ReplayFinding[] = [];
  for (const [t, r] of now) if (!r.ok && b.get(t)?.ok) findings.push({ id: `T_${t}`, desc: `existing test ${t}, as it was before the change, run against the changed code`, before: "PASS", after: `FAIL: ${r.out || "(no output)"}` });
  return { findings, ran: now.size };
}
const patchTests = (patch: string): string[] => [...readFileSync(patch, "utf8").matchAll(/^\+\+\+ b\/(\S+_test\.go)$/gm)].map((m) => m[1]!);

// ---- fixtures ----
interface Fx { name: string; dir: string; pkgDir: string; pkg: string; issue: string; files: Record<string, string>; tests: Record<string, string>; variants: string[] }
const fx = (name: string): Fx => {
  const dir = join(here, "fixtures", name), repo = join(dir, "repo"), pkgDir = readdirSync(repo).find((n) => statSync(join(repo, n)).isDirectory() && readdirSync(join(repo, n)).some((f) => f.endsWith(".go")))!;
  const files: Record<string, string> = {}, tests: Record<string, string> = {};
  for (const f of readdirSync(join(repo, pkgDir)).filter((f) => f.endsWith(".go"))) (f.endsWith("_test.go") ? tests : files)[`${pkgDir}/${f}`] = readFileSync(join(repo, pkgDir, f), "utf8");
  return { name, dir, pkgDir, pkg: /^package (\w+)/m.exec(Object.values(files)[0]!)![1]!, issue: readFileSync(join(dir, "issue.md"), "utf8"), files, tests, variants: readdirSync(join(dir, "variants")).filter((f) => f.endsWith(".patch")).map((f) => f.replace(/\.patch$/, "")).sort() };
};
const FX = [fx("gitlog"), fx("flagusage")];
/** Functions the issue names (pre-implement: no diff exists yet). */
const named = (f: Fx): string[] => { const defs = Object.entries(f.files).flatMap(([, s]) => [...s.matchAll(/^func (?:\([^)]*\)\s*)?(\w+)\s*\(/gm)].map((m) => m[1]!)); return [...new Set(defs.filter((d) => new RegExp(`\\b${d}\\b`).test(f.issue)))]; };
const ctxOf = (f: Fx): NrdContext => { const n = named(f), callers = callersOf(n, f.files); return { issue: f.issue, lang: "go", pkg: f.pkg, files: f.files, tests: f.tests, edited: n, callers, sites: outputSites(f.files, [...n, ...callers]), repoTests: f.tests }; };

const programs = new Map<string, string>();
for (const f of FX) {
  const c = ctxOf(f);
  if (mode === "dry") { console.log(f.name, "named", c.edited, "callers", c.callers, "sites", c.sites!.length, "prompt chars", nrdProbePrompt(c).length); continue; }
  programs.set(f.name, extractProgram((await llm(SYS_NRD_PROBE, nrdProbePrompt(c))).text));
}
type Row = { fixture: string; variant: string; oracle: boolean | null; replay: ReplayFinding[]; keep: NrdResult | null };
const rows: Row[] = [];
for (const f of FX) for (const v of f.variants) {
  const patch = join(f.dir, "variants", `${v}.patch`), io = treeIo(join(f.dir, "repo"), join(work, f.name, v), patch, { pkgDir: f.pkgDir, pkg: f.pkg });
  const baseT = join(work, f.name, `${v}-base`), patT = join(work, f.name, `${v}-patched`);
  cpSync(join(f.dir, "repo"), baseT, { recursive: true }); cpSync(join(f.dir, "repo"), patT, { recursive: true });
  spawnSync("git", ["apply", "-p1", patch], { cwd: patT });
  const rp = baseTestReplay(baseT, patT, patchTests(patch), f.pkgDir, join(work, f.name, `${v}-replay`));
  const keep = programs.has(f.name) ? await runNoRegression(ctxOf(f), noJudge, io, { program: programs.get(f.name)! }) : null;
  rows.push({ fixture: f.name, variant: v, oracle: io.oracle(join(f.dir, "oracle", "oracle_test.go"), "Oracle"), replay: rp.findings, keep });
}
// real commits: base tests against the maintainer's code change (fp.ts's tree shape: tests stay at base)
const commits = (JSON.parse(readFileSync(join(here, "fp", "commits.json"), "utf8")) as { commits: { id: string; repo: string; dir: string; sha: string; file: string; issue: string }[] }).commits;
const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const crow: { id: string; issue: string; editedTests: string[]; replay: ReplayFinding[]; ran: number }[] = [];
for (const c of commits) {
  const clone = join(repos, c.dir), b = join(work, "commits", c.id, "base"), p = join(work, "commits", c.id, "patched");
  for (const d of [b, p]) { mkdirSync(d, { recursive: true }); execFileSync("sh", ["-c", `git -C "$1" archive "$2^" | tar -x -C "$3"`, "sh", clone, c.sha, d]); if (!existsSync(join(d, "go.mod"))) writeFileSync(join(d, "go.mod"), `module github.com/${c.repo}\n\ngo 1.21\n`); }
  const changed = git(clone, "diff", "--name-only", `${c.sha}^`, c.sha).split("\n").filter(Boolean);
  for (const f of changed.filter((x) => x.endsWith(".go"))) writeFileSync(join(p, f), git(clone, "show", `${c.sha}:${f}`)); // the whole maintainer change, tests included
  const editedTests = changed.filter((x) => x.endsWith("_test.go"));
  const sub = c.file.includes("/") ? c.file.slice(0, c.file.lastIndexOf("/")) : ".";
  const rp = baseTestReplay(b, p, editedTests, sub, join(work, "commits", c.id, "replay"));
  crow.push({ id: c.id, issue: c.issue, editedTests, replay: rp.findings, ran: rp.ran });
}
if (mode === "dry") { console.log(JSON.stringify({ rows: rows.map((r) => ({ f: r.fixture, v: r.variant, oracle: r.oracle, replay: r.replay.map((x) => x.id) })), commits: crow.map((c) => ({ id: c.id, editedTests: c.editedTests, ran: c.ran, replay: c.replay.map((x) => x.id) })) }, null, 1)); process.exit(0); }

// one batched judge call
const key = (x: { id: string; before: string; after: string }) => `${x.id}\u0000${x.before}\u0000${x.after}`;
const sections: { tag: string; issue: string; cases: ReplayFinding[] }[] = [];
for (const f of FX) { const seen = new Set<string>(), cases: ReplayFinding[] = []; for (const r of rows.filter((x) => x.fixture === f.name)) for (const x of [...r.replay, ...(r.keep?.findings ?? [])]) if (!seen.has(key(x))) { seen.add(key(x)); cases.push({ id: x.id, desc: x.desc, before: x.before, after: x.after }); } sections.push({ tag: f.name, issue: f.issue, cases }); }
for (const c of crow) sections.push({ tag: c.id, issue: c.issue, cases: c.replay });
const live = sections.filter((s) => s.cases.length), verdict = new Map<string, Verdict>();
if (live.length) {
  // labels must be unique per task: a case id can repeat with different outputs across variants
  const lab = new Map<string, string>(); for (const s of live) s.cases.forEach((x, i) => lab.set(`${s.tag}\u0000${key(x)}`, `${s.tag}-${i + 1}`));
  const text = (await llm(SYS_NRD_JUDGE, [`There are ${live.length} independent tasks. Judge each case against its own task's issue only.`, ...live.map((s, n) => `=== TASK ${n + 1} ===\n${nrdJudgePrompt(s.issue, s.cases.map((x) => ({ label: lab.get(`${s.tag}\u0000${key(x)}`)!, desc: x.desc, before: x.before, after: x.after })))}`), "Answer one line per case, with the case id exactly as written: <case id>: requested|unrequested|unknown"].join("\n\n"))).text;
  const v = parseNrdVerdicts(text); for (const [k, l] of lab) verdict.set(k, v.get(l) ?? "unknown");
}
const issueOf = (tag: string) => sections.find((x) => x.tag === tag)!.issue;
// round 5: the override applies to keep cases only; a replayed test failure is judged as is
const vOf = (tag: string, x: ReplayFinding, keep: boolean): Verdict | undefined => { const v = verdict.get(`${tag}\u0000${key(x)}`); return keep && v ? overrideVerdict(issueOf(tag), x, v) : v; };
const blocks = (tag: string, xs: ReplayFinding[], keep = false) => xs.filter((x) => vOf(tag, x, keep) === "unrequested").map((x) => x.id);
const out = rows.map((r) => ({ fixture: r.fixture, variant: r.variant, oracle: r.oracle, replayBlocks: blocks(r.fixture, r.replay), keepBlocks: blocks(r.fixture, r.keep?.findings ?? [], true).filter((id) => !(r.keep?.advisory ?? []).includes(id)), replayFindings: r.replay.map((x) => `${x.id}:${verdict.get(`${r.fixture}\u0000${key(x)}`)}`), keepFindings: (r.keep?.findings ?? []).map((x) => `${x.id}:${vOf(r.fixture, x, true)}`), uncovered: r.keep?.uncovered }));
const cout = crow.map((c) => ({ id: c.id, editedTests: c.editedTests.length, ran: c.ran, replayFindings: c.replay.map((x) => `${x.id}:${verdict.get(`${c.id}\u0000${key(x)}`)}`), falseFire: blocks(c.id, c.replay).length > 0 }));
const score = (f: string, which: "replayBlocks" | "keepBlocks" | "both") => { const rs = out.filter((r) => r.fixture === f), fires = (r: (typeof out)[number]) => (which === "both" ? r.replayBlocks.length + r.keepBlocks.length : r[which].length) > 0; return { caught: `${rs.filter((r) => r.oracle === false && fires(r)).length}/${rs.filter((r) => r.oracle === false).length}`, falseFires: `${rs.filter((r) => r.oracle === true && fires(r)).length}/${rs.filter((r) => r.oracle === true).length}` }; };
const summary = { calls: transcripts.length, costUsd: transcripts.reduce((a, t) => a + t.usage.costUsd, 0), outTok: transcripts.map((t) => t.usage.outTok),
  gitlog: { replay: score("gitlog", "replayBlocks"), keepPreImplement: score("gitlog", "keepBlocks"), both: score("gitlog", "both") },
  flagusage: { replay: score("flagusage", "replayBlocks"), keepPreImplement: score("flagusage", "keepBlocks"), both: score("flagusage", "both") },
  commits: { replayFalseFires: `${cout.filter((c) => c.falseFire).length}/${cout.length}`, withReplayFinding: `${cout.filter((c) => c.replayFindings.length).length}/${cout.length}` } };
writeFileSync(join(work, "round4-report.json"), JSON.stringify({ summary, rows: out, commits: cout, programs: Object.fromEntries(programs) }, null, 2));
writeFileSync(join(work, "round4-transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ summary, rows: out, commits: cout }, null, 1));
