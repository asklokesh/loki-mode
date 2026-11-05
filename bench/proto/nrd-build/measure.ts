// BUILD-readiness measurement of features/no_regression.ts on the shared tournament runner. Default path: the probe cases come from
// the pre-implement exec-spec probe block (GO_PROBE_RULES plus the per-run keep ledger), one call per task; base-test replay costs
// nothing; one batched judge call covers every finding, with each rewritten test expectation shown. The post-implement probe call is
// counted (postProbeNeeded) and made only where it fires. Scratch trees only. Usage:
//   bun measure.ts <work-dir> <repos-dir> haiku|dry|replay [transcripts.json]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { callersOf, editedSymbols, postProbeFocus, keepLedger, nrdJudgePrompt, outputSites, overrideVerdict, parseGoTestJson, parseNrdVerdicts, postProbeNeeded, probeDiff, probeFindings, replayFindings, SYS_NRD_JUDGE, uncoveredSites, type Finding, type Verdict } from "../../../loki-ts/src/features/no_regression.ts";
import { GO_PROBE_RULES, parseGoProbeCases } from "../../../loki-ts/src/features/tournament.ts";
import { haikuCli, replayCalls, type Transcript } from "../haiku_cli.ts";

const [workArg, reposArg, mode, canned] = process.argv.slice(2) as [string, string, string, string | undefined];
const work = resolve(workArg), repos = resolve(reposArg), here = import.meta.dir; mkdirSync(work, { recursive: true });
const transcripts: Transcript[] = [];
const llm = mode === "replay" ? replayCalls(canned!, transcripts) : haikuCli(work, transcripts, { effort: "low", timeoutMs: 900_000 });
const goEnv = { ...process.env, GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };
const goJson = (dir: string, pkgRel: string) => parseGoTestJson(spawnSync("go", ["test", "-count=1", "-vet=off", "-json", `./${pkgRel || ""}`], { cwd: dir, encoding: "utf8", env: goEnv, timeout: 300_000 }).stdout ?? "");

interface Task { tag: string; issue: string; pkg: string; pkgRel: string; files: Record<string, string>; tests: Record<string, string>; ledger: string; sites: ReturnType<typeof outputSites> }
const SYS_PROBE = "You write a small behavioral probe file. Output only one fenced Go code block.";
const probePrompt = (t: Task): string => [`ISSUE:\n${t.issue}`, ...Object.entries(t.files).map(([p, s]) => `FILE ${p} (before the fix):\n${s}`), ...Object.entries(t.tests).map(([p, s]) => `EXISTING TEST ${p}:\n${s}`), GO_PROBE_RULES.split("\n").slice(1).join("\n"), `The probe file starts with: package ${t.pkg}`, ...(t.ledger ? [t.ledger] : [])].join("\n\n");
const named = (issue: string, files: Record<string, string>): string[] => [...new Set(Object.values(files).flatMap((s) => [...s.matchAll(/^func (?:\([^)]*\)\s*)?(\w+)\s*\(/gm)].map((m) => m[1]!)))].filter((d) => new RegExp(`\\b${d}\\b`).test(issue));
const task = (tag: string, issue: string, pkg: string, pkgRel: string, files: Record<string, string>, tests: Record<string, string>): Task => {
  const n = named(issue, files), sites = outputSites(files, [...n, ...callersOf(n, files)]);
  return { tag, issue, pkg, pkgRel, files, tests, ledger: keepLedger(sites), sites };
};
const goFiles = (dir: string, rel: string) => { const files: Record<string, string> = {}, tests: Record<string, string> = {}; for (const f of readdirSync(join(dir, rel)).filter((x) => x.endsWith(".go"))) (f.endsWith("_test.go") ? tests : files)[rel ? `${rel}/${f}` : f] = readFileSync(join(dir, rel, f), "utf8"); return { files, tests }; };

// fixtures
type Case = { tag: string; task: Task; name: string; base: string; patched: string; editedTests: string[]; changedGo: string[]; oracle: boolean | null };
const cases: Case[] = [], tasks: Task[] = [];
for (const fx of ["gitlog", "flagusage"]) {
  const dir = join(here, "fixtures", fx), repo = join(dir, "repo"), pkgRel = readdirSync(repo).find((n) => statSync(join(repo, n)).isDirectory())!;
  const { files, tests } = goFiles(repo, pkgRel), t = task(fx, readFileSync(join(dir, "issue.md"), "utf8"), /^package (\w+)/m.exec(Object.values(files)[0]!)![1]!, pkgRel, files, tests); tasks.push(t);
  for (const v of readdirSync(join(dir, "variants")).filter((f) => f.endsWith(".patch")).map((f) => f.replace(/\.patch$/, "")).sort()) {
    const b = join(work, fx, v, "base"), p = join(work, fx, v, "patched"), patch = join(dir, "variants", `${v}.patch`);
    cpSync(repo, b, { recursive: true }); cpSync(repo, p, { recursive: true }); spawnSync("git", ["apply", "-p1", patch], { cwd: p });
    const changed = [...readFileSync(patch, "utf8").matchAll(/^\+\+\+ b\/(\S+)$/gm)].map((m) => m[1]!);
    const o = join(work, fx, v, "oracle"); cpSync(p, o, { recursive: true }); cpSync(join(dir, "oracle", "oracle_test.go"), join(o, pkgRel, "zz_oracle_test.go"));
    cases.push({ tag: fx, task: t, name: v, base: b, patched: p, editedTests: changed.filter((f) => f.endsWith("_test.go")), changedGo: changed.filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")), oracle: spawnSync("go", ["test", "-count=1", "-run", "Oracle", `./${pkgRel}`], { cwd: o, env: goEnv }).status === 0 });
  }
}
// real commits: base = parent, patched = the whole maintainer change (tests included)
const commits = (JSON.parse(readFileSync(join(here, "fp", "commits.json"), "utf8")) as { commits: { id: string; repo: string; dir: string; sha: string; file: string; issue: string }[] }).commits;
const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
for (const c of commits) {
  const clone = join(repos, c.dir), b = join(work, "commits", c.id, "base"), p = join(work, "commits", c.id, "patched");
  for (const d of [b, p]) { mkdirSync(d, { recursive: true }); execFileSync("sh", ["-c", `git -C "$1" archive "$2^" | tar -x -C "$3"`, "sh", clone, c.sha, d]); if (!existsSync(join(d, "go.mod"))) writeFileSync(join(d, "go.mod"), `module github.com/${c.repo}\n\ngo 1.21\n`); }
  const changed = git(clone, "diff", "--name-only", `${c.sha}^`, c.sha).split("\n").filter((x) => x.endsWith(".go"));
  for (const f of changed) writeFileSync(join(p, f), git(clone, "show", `${c.sha}:${f}`));
  const rel = c.file.includes("/") ? dirname(c.file) : "", { files, tests } = goFiles(b, rel), pkg = /^package (\w+)/m.exec(Object.values(files)[0]!)![1]!;
  // the exec-spec call sees only what the issue names: a large package is cut to the named definitions' files plus the changed file's head
  const t = task(c.id, c.issue, pkg, rel, files, tests);
  const keepFiles = Object.fromEntries(Object.entries(files).filter(([f, s]) => f === c.file || named(c.issue, { [f]: s }).length > 0).map(([f, s]) => [f, s.slice(0, 14_000)]));
  const keepTests = Object.fromEntries(Object.entries(tests).filter(([, s]) => named(c.issue, files).some((n) => s.includes(n))).slice(0, 2).map(([f, s]) => [f, s.slice(0, 6_000)]));
  tasks.push({ ...t, files: keepFiles, tests: keepTests });
  cases.push({ tag: c.id, task: tasks[tasks.length - 1]!, name: c.id, base: b, patched: p, editedTests: changed.filter((f) => f.endsWith("_test.go")), changedGo: changed.filter((f) => !f.endsWith("_test.go")), oracle: true });
}

if (mode === "dry") { for (const t of tasks) console.log(t.tag, "sites", t.sites.length, "prompt chars", probePrompt(t).length); }
// pre-implement probe programs: one call per fixture, one batched call for the commits
const programs = new Map<string, string>();
const take = (t: Task, text: string) => { const m = /```go[^\n]*\n([\s\S]*?)```/.exec(text); const p = parseGoProbeCases(m ? m[1]! : null, t.pkg); if ("file" in p) programs.set(t.tag, p.file); };
if (mode !== "dry") {
  for (const t of tasks.slice(0, 2)) take(t, (await llm(SYS_PROBE, probePrompt(t))).text);
  const ct = tasks.slice(2), text = (await llm("You write small behavioral probe files. For each task output its header line, then one fenced Go code block, nothing else.", [`There are ${ct.length} independent tasks; never mix code between them.`, ...ct.map((t, i) => `=== TASK ${i + 1} ===\n${probePrompt(t)}`), "Output, for each task in order, the line === TASK <n> === followed by its one Go code block."].join("\n\n"))).text;
  const parts = text.split(/^=== TASK (\d+) ===\s*$/m); for (let i = 1; i + 1 < parts.length; i += 2) { const t = ct[Number(parts[i]) - 1]; if (t) take(t, parts[i + 1]!); }
}
// findings per case
type Row = { tag: string; name: string; oracle: boolean | null; findings: Finding[]; postProbe: string[]; uncovered: string[]; built: boolean };
const rows: Row[] = [];
for (const c of cases) {
  const tests = c.editedTests.map((f) => ({ base: readFileSync(join(c.base, f), "utf8"), patched: readFileSync(join(c.patched, f), "utf8") }));
  let replay: Finding[] = [];
  if (c.editedTests.length) { const r = join(dirname(c.patched), "replay"); cpSync(c.patched, r, { recursive: true }); for (const f of c.editedTests) cpSync(join(c.base, f), join(r, f)); replay = replayFindings(goJson(c.base, c.task.pkgRel), goJson(r, c.task.pkgRel), tests); }
  const edited = c.changedGo.flatMap((f) => editedSymbols(f, readFileSync(join(c.base, f), "utf8"), readFileSync(join(c.patched, f), "utf8")));
  const post = postProbeNeeded(c.task.issue, edited, goFiles(c.base, c.task.pkgRel).files);
  const prog = programs.get(c.tag), d = prog ? probeDiff(c.base, c.patched, c.task.pkgRel, c.task.pkg, prog) : null;
  rows.push({ tag: c.tag, name: c.name, oracle: c.oracle, findings: [...replay, ...(d ? probeFindings(d.cases) : [])], postProbe: post, uncovered: d ? uncoveredSites(c.task.sites, d.probes).map((s) => s.id) : [], built: !!d?.built });
}
// post-implement probe: only for runs where an edited function has callers the issue does not name; one batched call
const post = cases.map((c, i) => ({ c, r: rows[i]! })).filter((x) => x.r.postProbe.length);
if (post.length && mode !== "dry") {
  const text = (await llm("You write small behavioral probe files. For each task output its header line, then one fenced Go code block, nothing else.", [`There are ${post.length} independent tasks; never mix code between them.`, ...post.map((x, i) => `=== TASK ${i + 1} ===\n${probePrompt(x.c.task)}\n\n${postProbeFocus(x.c.changedGo.flatMap((f) => editedSymbols(f, readFileSync(join(x.c.base, f), "utf8"), readFileSync(join(x.c.patched, f), "utf8"))), x.r.postProbe)}`), "Output, for each task in order, the line === TASK <n> === followed by its one Go code block."].join("\n\n"))).text;
  const parts = text.split(/^=== TASK (\d+) ===\s*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const x = post[Number(parts[i]) - 1]; if (!x) continue;
    const m = /```go[^\n]*\n([\s\S]*?)```/.exec(parts[i + 1]!), pr = parseGoProbeCases(m ? m[1]! : null, x.c.task.pkg); if (!("file" in pr)) continue;
    const d = probeDiff(x.c.base, x.c.patched, x.c.task.pkgRel, x.c.task.pkg, pr.file.replace(/lokiProbe\(\s*"([^"]+)"/g, 'lokiProbe("post_$1"'));
    x.r.findings.push(...probeFindings(d.cases));
  }
}
if (mode === "dry") { console.log(JSON.stringify(rows.map((r) => ({ tag: r.tag, name: r.name, oracle: r.oracle, replay: r.findings.map((f) => `${f.id}${f.testEdit ? " +edit" : ""}`), postProbe: r.postProbe })), null, 1)); process.exit(0); }
// one batched judge call
const key = (f: Finding) => `${f.id}\u0000${f.before}\u0000${f.after}`, verdict = new Map<string, Verdict>();
const sections = [...new Set(rows.map((r) => r.tag))].map((tag) => { const seen = new Map<string, Finding & { label: string }>(); for (const r of rows.filter((x) => x.tag === tag)) for (const f of r.findings) if (!seen.has(key(f))) seen.set(key(f), { ...f, label: `${tag}-${seen.size + 1}` }); return { tag, issue: rows.find((r) => r.tag === tag) ? tasks.find((t) => t.tag === tag)!.issue : "", cases: [...seen.values()] }; }).filter((s) => s.cases.length);
if (sections.length) {
  const v = parseNrdVerdicts((await llm(SYS_NRD_JUDGE, [`There are ${sections.length} independent tasks. Judge each case against its own task's issue only.`, ...sections.map((s, n) => `=== TASK ${n + 1} ===\n${nrdJudgePrompt(s.issue, s.cases)}`), "Answer one line per case, with the case id exactly as written: <case id>: requested|unrequested|unknown"].join("\n\n"))).text);
  for (const s of sections) for (const c of s.cases) verdict.set(`${s.tag}\u0000${key(c)}`, overrideVerdict(s.issue, c, v.get(c.label) ?? "unknown"));
}
const out = rows.map((r) => { const vs = r.findings.map((f) => ({ f, v: verdict.get(`${r.tag}\u0000${key(f)}`) ?? "unknown" })); return { tag: r.tag, name: r.name, oracle: r.oracle, built: r.built, postProbe: r.postProbe, uncovered: r.uncovered, replay: vs.filter((x) => x.f.source === "replay").map((x) => `${x.f.id}:${x.v}`), probe: vs.filter((x) => x.f.source === "probe").map((x) => `${x.f.id}:${x.v}`), fires: vs.some((x) => x.v === "unrequested"), replayFires: vs.some((x) => x.f.source === "replay" && x.v === "unrequested"), probeFires: vs.some((x) => x.f.source === "probe" && x.v === "unrequested") }; });
const sc = (tag: string, k: "fires" | "replayFires" | "probeFires") => { const rs = out.filter((r) => r.tag === tag); return `caught ${rs.filter((r) => r.oracle === false && r[k]).length}/${rs.filter((r) => r.oracle === false).length}, false fires ${rs.filter((r) => r.oracle === true && r[k]).length}/${rs.filter((r) => r.oracle === true).length}`; };
const cm = out.filter((r) => !["gitlog", "flagusage"].includes(r.tag));
const summary = { calls: transcripts.length, costUsd: transcripts.reduce((a, t) => a + t.usage.costUsd, 0), outTok: transcripts.map((t) => t.usage.outTok),
  gitlog: { all: sc("gitlog", "fires"), replay: sc("gitlog", "replayFires"), probe: sc("gitlog", "probeFires") }, flagusage: { all: sc("flagusage", "fires"), probe: sc("flagusage", "probeFires") },
  commits: { falseFires: `${cm.filter((r) => r.fires).length}/${cm.length}`, replayFalseFires: `${cm.filter((r) => r.replayFires).length}/${cm.length}`, probeFalseFires: `${cm.filter((r) => r.probeFires).length}/${cm.length}`, withFinding: `${cm.filter((r) => r.replay.length + r.probe.length > 0).length}/${cm.length}` },
  postProbeWouldFire: `${out.filter((r) => r.postProbe.length).length}/${out.length}` };
writeFileSync(join(work, "measure-report.json"), JSON.stringify({ summary, rows: out, programs: Object.fromEntries(programs) }, null, 2)); writeFileSync(join(work, "measure-transcripts.json"), JSON.stringify(transcripts, null, 2));
console.log(JSON.stringify({ summary, rows: out }, null, 1));
