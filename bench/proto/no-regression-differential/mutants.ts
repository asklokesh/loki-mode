// Zero-call recall probe: how often do the recorded probe programs SEE an unrequested change? On top of each real
// maintainer commit (fp/commits.json), one string literal in the changed file, outside the definitions the commit edited,
// gets a suffix: a stand-in for an agent's unasked change to an unrelated output string. A mutant the repo's own tests
// already fail on is caught today; the interesting ones survive those tests. Counted: mutants on which at least one keep case
// changed (it would go to the judge). No model call: the programs come from the recorded run. Usage:
//   bun mutants.ts <commits.json> <repos-dir> <transcripts.json> <work-dir> [per-commit-cap]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { extractProgram, runGoProbe, type ProbeExec } from "../../../loki-ts/src/features/probes.ts";
import { editedSymbols, runNoRegression, SYS_NRD_JUDGE, type NrdIo } from "../../../loki-ts/src/features/no_regression.ts";
import { symbolSpans } from "../../../loki-ts/src/util/context_pack.ts";
import type { LlmCall } from "../../../loki-ts/src/features/tournament.ts";
import { sh } from "./tree_io.ts";

const [listArg, reposArg, trArg, workArg, capArg] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const repos = resolve(reposArg), work = resolve(workArg), cap = Number(capArg ?? 8);
const commits = (JSON.parse(readFileSync(listArg, "utf8")) as { commits: { id: string; repo: string; dir: string; sha: string; file: string; issue: string }[] }).commits;
const batch = (JSON.parse(readFileSync(trArg, "utf8")) as { system: string; text: string }[]).find((t) => !t.system.startsWith("You decide"))!.text;
const parts = batch.split(/^=== TASK (\d+) ===\s*$/m), programs: string[] = [];
for (let i = 1; i + 1 < parts.length; i += 2) programs[Number(parts[i]) - 1] = extractProgram(parts[i + 1]!);
const env = { GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const never: LlmCall = async (system) => { if (system === SYS_NRD_JUDGE) return { text: "", usage: { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } }; throw new Error("no probe call in this experiment"); };

/** String literals ("...", with a letter) inside definitions the commit did not edit: [start, end) offsets of their contents. */
function literalSites(path: string, src: string, edited: string[]): { at: number; end: number; text: string; fn: string }[] {
  const lines = src.split("\n"), offs: number[] = [0];
  for (const l of lines) offs.push(offs[offs.length - 1]! + l.length + 1);
  const out: { at: number; end: number; text: string; fn: string }[] = [];
  for (const s of symbolSpans(path, src)) {
    if (s.container || edited.includes(s.name)) continue;
    const from = offs[s.start - 1]!, to = offs[s.end]!, body = src.slice(from, to);
    for (const m of body.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
      const pre = body.slice(Math.max(0, m.index! - 1), m.index!);
      if (pre === "`" || !/[A-Za-z]{2}/.test(m[1]!) || /^%\w$/.test(m[1]!)) continue;
      const line = body.slice(body.lastIndexOf("\n", m.index!) + 1, body.indexOf("\n", m.index!));
      if (/^\s*\/\//.test(line)) continue; // a comment line
      out.push({ at: from + m.index! + 1, end: from + m.index! + 1 + m[1]!.length, text: m[1]!, fn: s.name });
    }
  }
  return out;
}

mkdirSync(work, { recursive: true });
const rows = [];
for (const [k, c] of commits.entries()) {
  const program = programs[k];
  if (!program) { rows.push({ id: c.id, skipped: "no recorded program" }); continue; }
  const clone = join(repos, c.dir), dir = join(work, c.id);
  mkdirSync(dir, { recursive: true });
  execFileSync("sh", ["-c", `git -C "$1" archive "$2^" | tar -x -C "$3"`, "sh", clone, c.sha, dir]);
  sh(dir, "sh", ["-c", `[ -f go.mod ] || printf 'module github.com/${c.repo}\\n\\ngo 1.21\\n' > go.mod`]);
  const base = git(clone, "show", `${c.sha}^:${c.file}`), patched = git(clone, "show", `${c.sha}:${c.file}`);
  const pkg = /^package (\w+)/m.exec(base)![1]!, edited = editedSymbols(c.file, base, patched);
  const sites = literalSites(c.file, patched, edited), step = Math.max(1, Math.ceil(sites.length / cap));
  const chosen = sites.filter((_, i) => i % step === 0).slice(0, cap);
  // The reference run (the maintainer's commit alone) runs base twice for real; every mutant then reuses its last base
  // result, since the base tree is identical for all of them. The patched side always runs twice.
  let lastBase: { p: string; e: ProbeExec } | null = null, reuseBase = false;
  const file = join(dir, c.file);
  const ioFor = (text: string): NrdIo => ({
    run(state, p) {
      if (state === "base" && reuseBase && lastBase && lastBase.p === p) return { ...lastBase.e, roots: [dir] };
      writeFileSync(file, state === "base" ? base : text);
      const e = runGoProbe({ moduleRoot: dir, pkgDir: ".", pkg, program: p, env });
      if (state === "base") lastBase = { p, e };
      return { ...e, roots: [dir] };
    },
  });
  const ref = await runNoRegression({ issue: c.issue, lang: "go", pkg, files: {}, tests: {} }, never, ioFor(patched), { program, verdicts: new Map() });
  reuseBase = true;
  writeFileSync(file, patched);
  const refOwnPass = sh(dir, "go", ["test", "-count=1", "-vet=off", "."], env).ok; // the commit itself must pass the base tests, or "own tests catch" means nothing
  const refKeep = new Set(ref.findings.map((f) => `${f.id}\u0000${f.after}`));
  const mutants = [];
  for (const s of chosen) {
    const text = patched.slice(0, s.end) + "_m" + patched.slice(s.end);
    writeFileSync(file, text);
    const own = sh(dir, "go", ["test", "-count=1", "-vet=off", "."], env);
    const r = await runNoRegression({ issue: c.issue, lang: "go", pkg, files: {}, tests: {} }, never, ioFor(text), { program, verdicts: new Map() });
    const seen = r.findings.filter((f) => !refKeep.has(`${f.id}\u0000${f.after}`)).map((f) => f.id); // keep cases this mutant changed beyond the commit itself
    const changeMoved = r.cases.filter((x) => x.kind !== "keep" && x.status === "changed" && !ref.cases.some((y) => y.id === x.id && y.after === x.after)).map((x) => x.id);
    mutants.push({ fn: s.fn, literal: s.text.slice(0, 50), ownTestsCatch: !own.ok, keepChanged: seen, changeCaseMoved: changeMoved });
  }
  writeFileSync(file, base);
  const survivors = mutants.filter((m) => !m.ownTestsCatch);
  rows.push({ id: c.id, refOwnPass, sites: sites.length, mutants: mutants.length, ownTestsCatch: mutants.length - survivors.length, survivors: survivors.length, survivorsSeen: survivors.filter((m) => m.keepChanged.length > 0).length, survivorsSeenOnlyByChangeCase: survivors.filter((m) => m.keepChanged.length === 0 && m.changeCaseMoved.length > 0).length, refFindings: ref.findings.map((f) => f.id), detail: mutants });
}
const live = rows.filter((r) => !("skipped" in r)) as { survivors: number; survivorsSeen: number; mutants: number; ownTestsCatch: number }[];
const summary = { commits: live.length, mutants: live.reduce((a, r) => a + r.mutants, 0), ownTestsCatch: live.reduce((a, r) => a + r.ownTestsCatch, 0), survivors: live.reduce((a, r) => a + r.survivors, 0), survivorsSeenByKeepCase: live.reduce((a, r) => a + r.survivorsSeen, 0) };
writeFileSync(join(work, "mutants-report.json"), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify({ summary, rows: rows.map((r) => ("skipped" in r ? r : { id: r.id, refOwnPass: r.refOwnPass, sites: r.sites, mutants: r.mutants, ownTestsCatch: r.ownTestsCatch, survivors: r.survivors, survivorsSeen: r.survivorsSeen, onlyChangeCase: r.survivorsSeenOnlyByChangeCase })) }, null, 1));
