// FC-16 (D86, L3/L5): the ONE place a check result is classified. A test check that executed zero tests is never a pass: it is
// not_run (NOT PROVEN, owned by the harness) with reason "no tests executed". A runner whose count cannot be parsed is the same,
// reported as unknown. A success verdict (VERIFIED or ALREADY_SATISFIED) needs at least one Loki-executed check with n>0 and a
// pass (hasExecutedProof). Every site that sets result "pass" for a test run routes through classifyCheck.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { killGroup, SAFE_BUN_FLAGS } from "../runner/worker_proc.ts";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { siteFor } from "../project_model/resolve.ts";
import type { ProjectApi } from "../project_model/api.ts";
import { CARGO_TEST_FILE_RE, isTestFile } from "../engine10/testmap.ts";
import type { RunnerName, TestRef } from "../engine10/types.ts";
import { declaresPythonDep } from "./lock_ecosystems.ts";
import { UNITTEST_DISCOVER_ARGS } from "./python_build_check.ts";
import { safeGit, safeGitSpawn, tokenFreeEnv } from "./safe_git.ts";
import { redactSecrets, UNSAFE_TERMINAL_CHARS_RE } from "./redact.ts";
import { clauseGapOf, extractClauses, weakAssertionNote } from "./spec_file.ts";

/** FC-69: the ONE child env for every harness-run test or verify command. A user's FORCE_COLOR=3 makes node:test, pytest, jest and
 *  friends emit ANSI that defeats line-anchored result parsers; FORCE_COLOR=0 + NO_COLOR=1 keeps the output plain. CI is left as is.
 *  FC-87: the base is token-filtered (GH_TOKEN family and SSH_AUTH_SOCK dropped), so a test command never carries credentials whatever the parent. */
export function plainTestEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokenFreeEnv(base))) if (typeof v === "string") e[k] = v;
  e["FORCE_COLOR"] = "0"; e["NO_COLOR"] = "1";
  delete e["CLICOLOR_FORCE"];
  return e;
}
export const NO_TESTS_REASON = "no tests executed";
/** The one owner of where a sealed Wall copy lives: <runDir>/wall/<basename>. Lives here (not wall.ts) because wall.ts imports this module; wall.ts re-exports it. */
export const sealedWallDir = (runDir: string): string => join(runDir, "wall");
export const sealedWallCopy = (runDir: string, path: string): string => join(sealedWallDir(runDir), basename(path));
export const NO_RUNNER_REASON = "no runner of this repo runs this file"; // FC-WALL-FILE-WITHOUT-RUNNER-SILENTLY-DROPPED: the one wording wall.ts (not_run_files) and verify.ts (not_proven) share, so seal dedups them
/** Machine-readable reason the Wall found no harness runner when bun was off (LOKI_WALL_HARNESS_RUNNER=0) or missing from PATH (the pre-spawn Bun.which check), else the repo simply has no toolchain; recorded as skip_code on the Wall skip. */
/** The skip_code values a check or stage can carry: the harnessSkipCode set plus tool_not_on_path (a runner command missing from PATH). */
export type SkipCode = "harness_runner_disabled" | "bun_not_on_path" | "no_toolchain" | "tool_not_on_path";
export const harnessSkipCode = (env: NodeJS.ProcessEnv = process.env): Exclude<SkipCode, "tool_not_on_path"> => (env.LOKI_WALL_HARNESS_RUNNER === "0" ? "harness_runner_disabled" : Bun.which("bun", { PATH: env.PATH ?? "" }) ? "no_toolchain" : "bun_not_on_path");
export const GO_EXIT0_REASON = "test count could not be confirmed: go test output is produced by the code under test and cannot confirm execution (a Go exit 0 is never a pass)";
export const UNCONFIRMED_REASON = "test count could not be confirmed";
/** Real failure evidence in a failed run: a failed test line, a go build or setup failure, a go compiler error line, or "N failed|errors". */
const FAIL_EVIDENCE = /\[(?:build|setup) failed\]|^--- FAIL|^[\w./-]+\.go:\d+:\d+: \S|\b[1-9]\d* (?:failed|errors?)\b/m;
/** Extra failure evidence honoured only for a Go runner under a non-zero exit: a package FAIL line (log.Fatal, init panic, timeout) or a panic. */
const GO_FAIL_EVIDENCE = /^FAIL\t\S+\t[\d.]+s$|^panic: /m;
export const UNMEASURED_REASON = "executed count unmeasured (Loki could not parse the runner summary, harness-owned)";

/** Executed-test count from the runner's FINAL summary only (node TAP/spec trailer, pytest last line, jest/vitest "Tests"
 *  line, cargo "test result:", go "[no test"), never test names or captured stdout above it; null = no summary. 0 = empty or
 *  all skipped, never a pass (A-111). Node counts a testless file as one pseudo-test named after the file: discounted only when its name is the path under test (A-111b). */
export function ran(raw: string, path?: string, ok?: boolean): number | null {
  const out = stripAnsi(raw);
  const n = (s: string, re: RegExp): number => +(s.match(re)?.[1] ?? 0);
  const blk = out.trimEnd().match(/(?:^|\n)((?:(?:#|\u2139) \w+ [\d.]+(?:\n|$)){5,})$/)?.[1];
  if (blk) { const c = n(blk, /(?:#|\u2139) pass (\d+)/) + n(blk, /(?:#|\u2139) fail (\d+)/); const nm = out.match(/^(?:ok \d+ - |\u2714 )(\S+\.[cm]?[jt]s)(?: \(|$)/m)?.[1]; return c === 1 && nm && (!path || basename(nm) === basename(path)) ? 0 : c; }
  const cg = cargoTrailer(out);
  if (cg.length) return cg.reduce((t, l) => t + n(l, /(\d+) passed/) + n(l, /(\d+) failed/), 0);
  const g = goCount(out, ok);
  if (g !== undefined) return g;
  const tail = tailLines(out);
  const l = tail.filter((x) => /^(?:=+ )?(?:\d+ \w+.*|no tests ran) in [\d.]+s|^\s*Tests?:?\s+\d|^No tests found/.test(x) && (!/^\s*Tests?:?\s+\d/.test(x) || tail.some((y) => /^\s*Test (?:Files|Suites):?\s+\d/.test(y)))).pop(); // forge guard: a bare "Tests: 5 passed" needs its "Test Files|Suites" sibling in the trailer
  if (!l) return null;
  return /^(?:=+ )?no tests (?:ran|found)|^No tests found|skipped/i.test(l) || /\d+ (?:passed|failed|errors?)/.test(l) ? n(l, /(\d+) passed/) + n(l, /(\d+) failed/) + n(l, /(\d+) errors?/) : null;
}
/** FC-69: the ONE ANSI stripper every tool-output parser reads through (CSI, 8-bit CSI, OSC; CRLF folded to LF). */
export const stripAnsi = (s: string): string => s.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/(?:\u001b\[|\u009b)[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
/** The runner's own trailer: the last 12 non-empty lines. Earlier lines are test output and never a summary (forged-summary guard, M1). */
const tailLines = (out: string): string[] => out.split("\n").filter((x) => x.trim()).slice(-12);
/** cargo test: one segment per "running N tests" header; a segment counts only through its LAST line being "test result:" (the real
 *  trailer). A "test result:" printed by a test (--nocapture) is followed by "test x ... ok" lines, so it never counts. The final
 *  segment must qualify, else nothing does. */
const CARGO_NOISE = /^\s*(?:Compiling|Finished|Running|Doc-tests|Fresh|Blocking|Downloaded|Downloading|Updating|Locking|Adding|Packaging|Building)\b|^(?:warning|error|note|help)\b|^\s*(?:-->|=\s|\||\d+\s*\||\^|~)|^(?:Some errors have detailed|For more information about)/;
function cargoLines(out: string): string[] {
  const ls = out.split("\n").filter((x) => x.trim());
  while (ls.length && CARGO_NOISE.test(ls[ls.length - 1]!)) ls.pop(); // cargo's own stderr (Finished, Running, warnings, "error: test failed") lands AFTER the stdout trailer when the streams are joined stdout-then-stderr
  return ls;
}
function cargoTrailer(out: string): string[] {
  const ls = cargoLines(out);
  const segs = cargoSegs(ls).map((g) => g.body);
  // Threat model: libtest runs inside the process that executes the code under test, so code can print a "test result: ok. N passed" line and std::process::exit(0)
  // (nothing in-process is unforgeable). libtest prints each test's own "test <name> ... ok" line only AFTER that test returns, so an early exit leaves the
  // summary claiming more passes than the segment has ok lines. A summary whose passed count exceeds its segment's distinct ok lines (or the dots of -q output) makes the WHOLE run unmeasured,
  // never just that segment. Under --nocapture a test's own output (a print!, a should_panic message) splits "test x ... " from its "ok"; a pending name followed by a line ending in "ok" counts as one ok line.
  // This reading alone does not match ok lines to real test names; corroboratePass does that against the runner's own listing for a plain `cargo test` command.
  const dotsOf = (body: string[]): number => body.filter((l) => /^[.iF]+(?:\s+\d+\/\d+)?$/.test(l.trim())).reduce((t, l) => t + (l.match(/\./g)?.length ?? 0), 0);
  let forged = false;
  const lastOf = (g: string[]): string | undefined => {
    const l = g[g.length - 1];
    if (!l?.startsWith("test result: ")) return undefined;
    const passed = +(l.match(/(\d+) passed/)?.[1] ?? 0), body = g.slice(0, -1);
    if (passed > Math.max(cargoNames(body).ok.size, dotsOf(body))) { forged = true; return undefined; }
    return l;
  };
  if (!segs.length) { const g: string[] = []; for (let k = ls.length - 1; k >= 0 && ls[k]!.startsWith("test result: "); k--) g.push(ls[k]!); return g.every((x) => !/[1-9]\d* passed/.test(x)) ? g : []; } // headerless trailer: no libtest header or ok lines to check, so only a zero-pass summary (never a pass) keeps its base reading; a claimed pass is unmeasured
  if (!lastOf(segs[segs.length - 1]!)) return [];
  const sums = segs.flatMap((g) => lastOf(g) ?? []);
  return forged ? [] : sums;
}
/** libtest segments: one per "running N tests" header (N kept), body = the lines after it except cargo's Running and Doc-tests notes. */
function cargoSegs(ls: readonly string[]): { n: number; body: string[] }[] {
  const segs: { n: number; body: string[] }[] = [];
  for (const l of ls) {
    const h = /^running (\d+) tests?\b/.exec(l);
    if (h) segs.push({ n: +h[1]!, body: [] });
    else if (segs.length && !/^\s*(?:Running |Doc-tests |Doctest)/.test(l)) segs[segs.length - 1]!.body.push(l);
  }
  return segs;
}
/** The names a libtest segment body reports ok and ignored, each without libtest's " - should panic" or rustdoc's " - compile[ fail]" suffix. */
function cargoNames(body: readonly string[]): { ok: Set<string>; ignored: Set<string> } {
  const ok = new Set<string>(), ignored = new Set<string>(), bare = (x: string): string => x.replace(/ - (?:should panic|compile(?: fail)?)$/, "");
  let pending: string | undefined;
  for (const raw of body) {
    // Only leading whitespace is trimmed: libtest prints "test x ... " with a trailing space before the test's own output (a should_panic message, a print! without newline), which splits it from its "ok".
    const l = raw.trimStart(), m = /^test (.+?) \.\.\.(?: (.*))?$/.exec(l);
    if (m) {
      const rest = m[2] ?? "";
      pending = undefined;
      if (/^ignored\b/.test(rest)) ignored.add(bare(m[1]!));
      else if (rest !== "FAILED") { if (/ok$/.test(rest)) ok.add(bare(m[1]!)); else pending = bare(m[1]!); }
    } else if (pending !== undefined && /ok$/.test(l.trimEnd())) { ok.add(pending); pending = undefined; }
  }
  return { ok, ignored };
}
/** bun test: only when the final line is "Ran N tests across", the nearest " N pass" / " N fail" lines above it. null = not bun output. */
function bunCount(out: string): number | null {
  const ls = out.split("\n").filter((x) => x.trim());
  if (!/^Ran \d+ tests? across \d+ files?\./.test(ls[ls.length - 1] ?? "")) return null;
  const blk = ls.slice(-9, -1);
  const last = (k: string): number => +(blk.map((x) => x.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`))?.[1]).filter(Boolean).pop() ?? 0);
  return last("pass") + last("fail");
}
/** python -m unittest: "Ran N tests in Xs" then OK / FAILED as the last two lines. Skipped and expected failures did not execute.
 *  L3: user code (an atexit handler) can print a forged trailer after a real one, so the trailer is never trusted alone: an
 *  second "Ran" block, or a verdict that contradicts the exit code, makes the count unknown (null). */
function unittestCount(out: string, ok?: boolean): number | null {
  const ls = out.split("\n").filter((x) => x.trim()), v = ls[ls.length - 1] ?? "", r = ls[ls.length - 2]?.match(/^Ran (\d+) tests? in [\d.]+s$/);
  if (!r || !/^(?:OK|FAILED)\b/.test(v)) return null;
  if (ls.filter((x) => /^Ran \d+ tests? in [\d.]+s$/.test(x)).length > 1) return null; // a second block may be an atexit forgery (also of an all-skipped "OK (skipped=N)")
  if ((ok === true && v.startsWith("FAILED")) || (ok === false && v.startsWith("OK"))) return null; // verdict contradicts the exit code
  return Math.max(0, +r[1]! - +(v.match(/skipped=(\d+)/)?.[1] ?? 0) - +(v.match(/expected failures=(\d+)/)?.[1] ?? 0));
}
const GO_PKG_RE = /^(?:ok|FAIL|\?)\s+\S+\s+(?:\(cached\)|[\d.]+s\b|\[(?:no test files|build failed|setup failed)\])/;
/** go test (-v): executed tests = top-level "--- PASS|FAIL" across every package. "[no test files]" is 0 only when no package ran tests.
 *  Non-verbose "ok pkg 0.1s" carries no count: null (unmeasured). undefined = not go output. */
function goCount(out: string, ok?: boolean): number | null | undefined {
  const lines = out.split("\n");
  if (!lines.some((x) => GO_PKG_RE.test(x))) return undefined;
  // a result line counts only after its own "=== RUN name"; a name that ever reports SKIP never counts (a forged PASS then t.Skip); the LAST status wins
  const last = new Map<string, string>(), seen = new Set<string>(), skip = new Set<string>(), failPkg = ok !== true && lines.some((x) => /^FAIL\s+\S+\s+[\d.]+s\b/.test(x));
  for (const x of lines) {
    const r = x.match(/^=== RUN\s+(\S+)/), m = x.match(/^--- (PASS|FAIL|SKIP): (\S+)/);
    if (r) seen.add(r[1]!); else if (m && (seen.has(m[2]!) || (m[1] === "FAIL" && failPkg))) { last.set(m[2]!, m[1]!); if (m[1] === "SKIP") skip.add(m[2]!); } // non-verbose go prints a FAIL line without "=== RUN"; a failing package line vouches for it, only when the run failed
  }
  for (const k of skip) last.set(k, "SKIP");
  if (ok === true && [...last.values()].includes("FAIL")) return null; // a FAIL line contradicts exit 0: forged (TestMain os.Exit(0)), unmeasured
  const t = [...last.values()].filter((v) => v !== "SKIP").length;
  if (t > 0) return t;
  if (lines.some((x) => /^(?:=== RUN|PASS$|FAIL$|testing: warning: no tests to run)/.test(x))) return 0;
  return lines.filter((x) => GO_PKG_RE.test(x)).every((x) => /\[no tests? (?:files|to run)\]/.test(x)) ? 0 : null;
}
/** Go is package-directory scoped: a test in tests/ cannot see root package code and only compiles through an implementer shim that is never committed. The Wall goes beside the first planned or named
 *  .go file in the texts (plan, then task), or at the repo root without one; pkg is a sibling's package clause, else the planned file's stem. */
const GO_SRC = /(?<![\w./-])((?:[\w.-]+\/)*[\w-]+)\.go(?!\w)/g;
const GO_DIR = /(?<![\w./:$-])((?:[\w.-]+\/)*[\w-]*[A-Za-z0-9][\w-])\/(?![\w{]|\.\w)|\b(?:director(?:y|ies)|folder|dir)\s+`((?:[\w.-]+\/)*[\w-]+)`/g;
// A package name is taken only when tied to the directory: "package X" right after it ("as package X", "directory as package X") or "package main in <dir>";
// "package" as an English noun elsewhere ("the npm package manager in api/") only shows the sentence talks about a package, the name stays the directory's.
const GO_PKG_AFTER = /^[\s,(:;-]*(?:(?:directory|dir|folder)\s+)?(?:(?:as|named|called)\s+)?(?:the\s+)?package\s+`?(?!(?:for|is|that|which|with|and|to|the|in|of|a|an|name|path)\b)([A-Za-z_]\w*)`?/;
const GO_MAIN_BEFORE = /\bpackage\s+main\s+(?:in|under|at|inside|within|into|to)\s+(?:the\s+)?(?:directory\s+)?$/;
const goRel = (r: string): string => r.replace(/^(?:\.\/)+/, "");
const GO_NON_PKG_WORD = /^(?:tests?|docs?|scripts?|vendor|node_modules)$/;
/** Go's own ignore rule: testdata and any segment starting with _ or . never hold a package the toolchain builds. */
const goIgnoredPath = (rel: string): boolean => rel.split("/").some((g) => g === "testdata" || g.startsWith("_") || g.startsWith("."));
const goSiblingPkg = (dir: string): string | undefined => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).map((f) => /^package\s+(\w+)/m.exec(readFileSync(join(dir, f), "utf8"))?.[1]).find(Boolean) : undefined;
export function plannedGoDir(repoDir: string, texts: string[]): { dir: string; pkg: string | null } {
  for (const t of texts) for (const m of t.matchAll(GO_SRC)) {
    const stem = goRel(m[1]!), rel = dirname(`${stem}.go`), base = stem.split("/").pop()!;
    if (stem.endsWith("_test") || base.startsWith("_") || base.startsWith(".") || (rel !== "." && goIgnoredPath(rel))) continue;
    const dir = join(repoDir, rel === "." ? "" : rel);
    return { dir, pkg: goSiblingPkg(dir) ?? base };
  }
  // No .go file named: a named package directory (a leading ./ is fine, backslash paths stay at the root). Per sentence, a directory counts when the word "package" sits
  // between its neighbouring directory mentions or it already holds a Go package; the package is a sibling's clause, else the one tied to the directory, else its name.
  for (const t of texts) for (const sentence of t.split(/(?<=[.!?])\s+|\n+/)) {
    const ms = [...sentence.matchAll(GO_DIR)].filter((m) => { const r = goRel((m[1] ?? m[2])!); return !goIgnoredPath(r) && !r.split("/").some((g) => GO_NON_PKG_WORD.test(g)); });
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]!, rel = goRel((m[1] ?? m[2])!), dir = join(repoDir, rel), sibling = goSiblingPkg(dir);
      const start = i === 0 ? 0 : ms[i - 1]!.index! + ms[i - 1]![0].length, end = i + 1 < ms.length ? ms[i + 1]!.index! : sentence.length;
      const tied = GO_PKG_AFTER.exec(sentence.slice(m.index! + m[0].length, end))?.[1] ?? (GO_MAIN_BEFORE.test(sentence.slice(start, m.index!)) ? "main" : undefined);
      if (!tied && !sibling && !/\bpackage\b/.test(sentence.slice(start, end))) continue;
      return { dir, pkg: sibling ?? tied ?? (rel.split("/").pop() ?? null) };
    }
  }
  return { dir: repoDir, pkg: null };
}
export const goPackageBrief = (repoDir: string, targetDir: string, runners: readonly string[], texts: string[]): string => { const p = runners.includes("go") ? plannedGoDir(repoDir, texts) : null; return p?.pkg && p.dir === targetDir ? `\n\nGo: your test files sit in the package directory, so each one starts with "package ${p.pkg}" and uses the package's identifiers directly.` : ""; };
/** One shared Go-runner detection for every caller (verify, deep, per-package suites): a shell command line or an argv. Chosen from the command, never from output. The answer is tri-state (see runsTool): a command word in command position is the tool, or the command is fully resolved and does not run it, or some word could not be resolved and the old any-word rule decides. Detecting go too often only fails closed (exit 0 is not_run, and corroboratePass accepts only a plain `go test` line). */
/** The ONE command-shape test for every runner we corroborate (go, cargo), tri-state. The narrow command-position answer is final only when every command word resolved to the tool itself, a known wrapper walked through, or a KNOWN non-tool runner (KNOWN_RUNNERS). An unknown command word, a variable command word ($GO) or a shell whose flags did not parse to -c leaves the command unresolved, and mentionsTool then falls back to the old any-word basename rule over the whole command, which fails closed. */
const KNOWN_RUNNERS = new Set(["pytest", "python", "python3", "node", "npm", "yarn", "pnpm", "bun", "deno", "jest", "vitest", "mocha", "make", "cd", "echo", "true", "ruby", "rspec", "bundle", "mvn", "gradle", "dotnet", "php", "phpunit", "mix", "swift", "ctest", "tox"]);
const SHELL_WORDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]), RESERVED_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);
// wrapper -> its flags that take a separate value (a value-less flag is skipped alone)
const WRAPPERS: Record<string, readonly string[]> = { env: ["-u", "-C", "--unset", "--chdir"], nice: ["-n"], timeout: ["-s", "-k", "--signal", "--kill-after"], xargs: ["-n", "-L", "-P", "-I", "-s", "-d", "-E", "-a"], sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"], doas: ["-u", "-C"], stdbuf: ["-i", "-o", "-e"], ionice: ["-c", "-n", "-p"], npx: ["-p", "--package"], bunx: [], pnpx: [], arch: [], taskset: ["-c"], chrt: [], time: ["-f", "-o"], command: [], exec: [], builtin: [], nohup: [], setsid: [], unbuffer: [], caffeinate: [], echo: [], printf: [] }; // echo and printf are doubtful wrappers on purpose: `echo go` stays a hit
/** Split a shell line into simple commands (arrays of unquoted words): quotes and backslashes are honoured, and `;`, `&`, `|`, a newline, a parenthesis and a backtick end one command. */
function simpleCommands(line: string): string[][] {
  const out: string[][] = []; let cur: string[] = [], w = "", has = false, q = "";
  const endWord = (): void => { if (has) cur.push(w); w = ""; has = false; };
  const endCmd = (): void => { endWord(); if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === q) q = ""; else if (q === '"' && ch === "\\" && i + 1 < line.length) w += line[++i]; else w += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; has = true; } else if (ch === "\\" && i + 1 < line.length) { w += line[++i]; has = true; }
    else if (/\s/.test(ch)) { if (ch === "\n") endCmd(); else endWord(); }
    else if (";&|()`".includes(ch)) { if (ch === "(" && w === "$") { w = ""; has = false; } endCmd(); }
    else { w += ch; has = true; }
  }
  endCmd(); return out;
}
/** Whether one simple command runs `tool`, tri-state: NO (resolved, not the tool), YES (the command word after reserved words, VAR=val assignments, redirections and known wrappers with their flags has basename `tool`), UNKNOWN (an unknown or variable command word, or a shell whose flags did not parse to -c). A path or argument named like the tool (pytest tests/go, make DIR=go, a package-manager test script passed --grep cargo) is a resolved NO. */
const NO = 0, YES = 1, UNKNOWN = 2;
type Tri = 0 | 1 | 2;
const triOr = (a: Tri, b: Tri): Tri => (a === YES || b === YES ? YES : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : NO);
function runsTool(tool: string, words: readonly string[], depth: number): Tri {
  let i = 0;
  for (;;) {
    while (i < words.length && (RESERVED_WORDS.has(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || /^\d*[<>]/.test(words[i]!))) i += /^\d*[<>]+$/.test(words[i]!) ? 2 : 1;
    const w = words[i]; if (w === undefined) return NO;
    if (w.includes("$")) return UNKNOWN;
    const name = basename(w); if (name === tool) return YES;
    if (SHELL_WORDS.has(name)) {
      for (let j = i + 1; j < words.length && /^-/.test(words[j]!); j++) if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[j]!)) return depth < 4 && words[j + 1] !== undefined && !/^-/.test(words[j + 1]!) ? anyCommandRuns(tool, words[j + 1]!, depth + 1) : UNKNOWN;
      return UNKNOWN;
    }
    if (name === "eval") return depth < 4 ? anyCommandRuns(tool, words.slice(i + 1).join(" "), depth + 1) : UNKNOWN;
    if (name === "rustup" && words[i + 1] === "run") { i += 3; continue; }
    if (["pnpm", "yarn", "bun", "npm"].includes(name) && ["exec", "x", "dlx"].includes(words[i + 1] ?? "")) { i += 2; continue; }
    const vf = WRAPPERS[name];
    if (!vf) return KNOWN_RUNNERS.has(name) ? NO : UNKNOWN;
    i++;
    for (; i < words.length; i++) {
      const a = words[i]!;
      if (name === "env" && a === "-S") return depth < 4 && words[i + 1] !== undefined ? anyCommandRuns(tool, words[i + 1]!, depth + 1) : UNKNOWN;
      if (a === "--") continue;
      if (a.startsWith("-")) { if (vf.includes(a)) i++; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) || (name === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(a))) continue;
      break;
    }
  }
}
const anyCommandRuns = (tool: string, line: string, depth = 0): Tri => simpleCommands(line).reduce<Tri>((acc, c) => triOr(acc, runsTool(tool, c, depth)), NO);
/** The command as a word list: an argv as is, a line split on whitespace. */
const commandWords = (cmd: string, args?: readonly string[]): string[] => (args ? [cmd, ...args] : cmd.trim().split(/\s+/));
/** Whether the command (a shell line, or an argv) runs `tool`. A resolved command answers from command position, so a mere path or argument named like the tool does not turn an honest pass into not_run; an unresolved one falls back to the old rule (ANY word whose basename is the tool), which only fails closed. */
function mentionsTool(tool: string, cmd: string, args?: readonly string[]): boolean {
  let r: Tri = args ? runsTool(tool, [cmd, ...args], 0) : anyCommandRuns(tool, cmd);
  if (args && r !== YES && [cmd, ...args].some((a) => /[;&|()`]/.test(a))) r = triOr(r, anyCommandRuns(tool, [cmd, ...args].join(" "))); // an argv element carrying shell syntax is also read as a line
  if (r !== UNKNOWN) return r === YES;
  return commandWords(cmd, args).some((t) => t.split(/[\s"'`();&|<>${}\[\],=]+/).some((x) => x !== "" && basename(x) === tool));
}
/** One shared Go-runner detection for every caller (verify, deep, per-package suites): a shell command line or an argv, decided by the tri-state mentionsTool (command position when every command word resolved, otherwise the old any-word rule). Chosen from the command, never from output. Detecting go too often only fails closed (exit 0 is not_run, and corroboratePass accepts only a plain `go test` line). */
export function goRunner(cmd: string, args?: readonly string[]): { runner: "go" } | Record<string, never> {
  return mentionsTool("go", cmd, args) ? { runner: "go" } : {};
}
const CARGO_GLOBAL_FLAGS = new Set(["-v", "-vv", "--verbose", "-q", "--quiet", "--frozen", "--locked", "--offline"]), CARGO_OTHER_SUBS = new Set(["build", "check", "clippy", "fmt", "doc", "clean", "fetch", "tree", "run", "bench", "metadata", "update", "install", "publish", "package", "login", "search", "vendor"]);
/** A cargo invocation parsed strictly: `cargo [known global flags, their values consumed] <sub> [args]`, nothing before cargo (no wrapper, no shell, no +toolchain shim). null = not a plain invocation. */
function parseCargo(toks: readonly string[]): { global: string[]; sub: string; rest: string[] } | null {
  if (basename(toks[0] ?? "") !== "cargo" || toks.some((t) => /[&|;$`"'<>()\\]/.test(t))) return null;
  let k = 1;
  for (; k < toks.length; k++) {
    const t = toks[k]!;
    if (CARGO_GLOBAL_FLAGS.has(t) || /^--(?:color|config)=./.test(t)) continue;
    if ((t === "--color" || t === "--config") && toks[k + 1] !== undefined) { k++; continue; }
    break;
  }
  return toks[k] === undefined || toks[k]!.startsWith("-") || toks[k]!.startsWith("+") ? null : { global: toks.slice(1, k), sub: toks[k]!, rest: toks.slice(k + 1) };
}
/** go test -json: every non-empty line is a test2json event (or a "go: " tool note), else null (parse doubt). The go command frames the test
 *  binary's stdout as events, but test or implementation code that prints \x16-marked lines can make the framing emit run/pass events for tests that never ran;
 *  the stream alone is therefore not proof (see corroboratePass). failed = a test or package
 *  reported fail; failedTests = the Test names that failed; passed = top-level tests with a "run" event and a final pass (a skip never counts);
 *  complete = every started package has exactly one start and exactly one package-level terminal event, with no repeated run event. Exit 0 plus a complete event stream is counted from this alone, never from plain output (see GO_EXIT0_REASON). */
function goJson(out: string): { failed: boolean; failedTests: string[]; passed: number; passedNames: string[]; complete: boolean } | null {
  let any = false, failed = false, dirty = false;
  const status = new Map<string, string>(), ranSet = new Set<string>(), pkgs = new Set<string>(), failedTests = new Set<string>(), starts = new Map<string, number>(), done = new Map<string, number>();
  for (const x of out.split("\n")) {
    if (!x.trim() || /^go: /.test(x)) continue;
    let e: { Action?: unknown; Package?: unknown; Test?: unknown };
    try { e = JSON.parse(x) as typeof e; } catch { return null; }
    if (!e || typeof e !== "object" || typeof e.Action !== "string") return null;
    any = true;
    const pkg = typeof e.Package === "string" ? e.Package : "", test = typeof e.Test === "string" ? e.Test : "";
    if (e.Action === "start" && !test) { pkgs.add(pkg); starts.set(pkg, (starts.get(pkg) ?? 0) + 1); }
    if (e.Action === "fail") { failed = true; if (test) failedTests.add(`${pkg}::${test}`); }
    if (!/^build-/.test(e.Action) && !starts.has(pkg)) dirty = true; // an event for a package that never started: not the go command's framing
    if (!test && e.Action === "output" && /\[no tests to run\]/.test(String((e as { Output?: unknown }).Output ?? ""))) dirty = true;
    if (!test) { if (/^(?:pass|fail|skip)$/.test(e.Action)) done.set(pkg, (done.get(pkg) ?? 0) + 1); continue; }
    if (test.includes("/")) continue; // subtests roll up into their top-level test
    const k = `${pkg}::${test}`;
    if (e.Action === "run") { if (ranSet.has(k)) dirty = true; ranSet.add(k); }
    else if (ranSet.has(k) && /^(?:pass|fail|skip)$/.test(e.Action)) status.set(k, e.Action);
  }
  if (!any) return null;
  const passedNames = [...status].filter(([, v]) => v === "pass").map(([k]) => k);
  return { failed, failedTests: [...failedTests], passed: passedNames.length, passedNames, complete: !dirty && pkgs.size > 0 && [...pkgs].every((p) => starts.get(p) === 1 && done.get(p) === 1) }; // a torn stream or one with repeated starts, terminals or runs is doubt; a clean forged stream passes this and is caught by corroboratePass
}
export const CARGO_RUNNER_REASON = "test count could not be confirmed: a cargo target or alias setting can redirect both the test run and its listing";
export const CARGO_UNLISTED_REASON = "test count could not be confirmed: the cargo summary does not match the tests cargo lists for the same command";
/** A cargo pass is counted only when every libtest segment matches the runner's own listing, taken by running the same command with `-- --list` and `-- --list --ignored`.
 *  Threat model: libtest prints its results inside the process that runs the code under test, so code can print "test <name> ... ok" lines and a summary and exit 0
 *  (std::process::exit). A listing runs no test function, so its names and counts are the runner's, not the code's. Per segment, in order: the "running N tests" header,
 *  passed + failed + ignored + measured, and the listed count agree; the ignored count matches the ignored listing; every ok name is listed and not ignored; every ignored
 *  name is in the ignored listing. A segment count that differs from the listing, a listing that fails, or a line with shell syntax or the --ignored, --include-ignored,
 *  --list, --format or --logfile libtest flags stays not_run. Residual risk, stated plainly: code that prints the exact listed names of its own binary with a matching
 *  summary still forges, and so do code that runs before main (a link-section constructor) and a `harness = false` target, which control the listing too. build.rs (a build script runs arbitrary code before the tests) is a known gap, and so is the RUSTC_WRAPPER variable or a CARGO_HOME wrapper, left accepted on purpose because sccache users set them and refusing would make honest runs PARTIAL. A repo-committed build.rustc, rustc-wrapper, rustc-workspace-wrapper or linker is refused instead. */
/** A cargo [target] table (a runner, a linker, rustflags per target) or an [alias] can redirect both the test run and its listing, and TOML lets the key be written as a unicode escape inside a quoted key, so no text scan for one word is sound. Refused whenever any config cargo would load (every .cargo/config(.toml) from the cwd up, $CARGO_HOME or ~/.cargo, every --config value, inline or a file path that is read) has a target table or key, an alias table or key, or any \u or \U escape, or an `include`; also refused for any CARGO_TARGET_* or CARGO_ALIAS_* variable. A config that cannot be read is doubt. */
const CARGO_KEY = (name: string): RegExp => new RegExp(`(?:^|[\\s\\[,{.])["']?${name}["']?\\s*[.\\]=]`, "m");
const CARGO_TARGET_KEY = CARGO_KEY("target"), CARGO_ALIAS_KEY = CARGO_KEY("alias"), CARGO_REDIRECT_TEXT = (t: string): boolean => CARGO_TARGET_KEY.test(t) || CARGO_ALIAS_KEY.test(t) || /\\[uU]/.test(t) || /^\s*include\s*=/m.test(t);
function cargoRunnerConfigured(cwd: string, env: NodeJS.ProcessEnv, toks: readonly string[]): boolean {
  if (Object.keys(env).some((k) => /^CARGO_(?:TARGET|ALIAS)_/i.test(k))) return true;
  const doubtful = (f: string): boolean => { try { return CARGO_REDIRECT_TEXT(readFileSync(f, "utf8")); } catch { return true; } };
  const vals = toks.flatMap((t, i) => (t === "--config" ? [toks[i + 1] ?? ""] : t.startsWith("--config=") ? [t.slice(9)] : []));
  for (const v of vals) { if (CARGO_REDIRECT_TEXT(v)) return true; const f = resolve(cwd, v); if (existsSync(f) && lstatSync(f).isFile() && doubtful(f)) return true; }
  const dirs = [env["CARGO_HOME"] ?? join(env["HOME"] ?? homedir(), ".cargo"), join(homedir(), ".cargo")]; // the env cargo is given decides CARGO_HOME; the account's own ~/.cargo is read too, as doubt
  for (let d = resolve(cwd), prev = ""; d !== prev; prev = d, d = dirname(d)) dirs.push(join(d, ".cargo"));
  return dirs.some((dir) => ["config", "config.toml"].some((f) => existsSync(join(dir, f)) && doubtful(join(dir, f))));
}
export const CARGO_TOOLCHAIN_REASON = "test count could not be confirmed: a rust-toolchain path or RUSTUP_TOOLCHAIN path hands every cargo call to a toolchain the repo controls";
/** A rustup toolchain given as a path (rust-toolchain.toml `[toolchain] path`, a legacy rust-toolchain file naming a path, or a path-shaped RUSTUP_TOOLCHAIN) hands every cargo call, the run and the listing alike, to a script the repo controls. Refused for a path in a rust-toolchain(.toml) in the cwd or any parent (the same walk as the .cargo parent walk). Named toolchains (stable, 1.89.0, with components or targets) stay accepted. Unreadable files and escapes are doubt. */
const lstatOk = (f: string): boolean => { try { lstatSync(f); return true; } catch { return false; } }; // a symlink counts, and a dangling one is read as doubt
const PATH_SHAPED = (v: string): boolean => /[\\/]/.test(v) || /^[.~]/.test(v.trim());
function cargoToolchainRedirected(cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (PATH_SHAPED(env["RUSTUP_TOOLCHAIN"] ?? "")) return true;
  const doubtful = (f: string): boolean => {
    try {
      const t = readFileSync(f, "utf8");
      if (/\\[uU]/.test(t) || CARGO_KEY("path").test(t) || /^\s*channel\s*=\s*["']([^"']*)["']/m.test(t) && PATH_SHAPED(/^\s*channel\s*=\s*["']([^"']*)["']/m.exec(t)![1]!)) return true;
      const first = t.split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("#")) ?? "";
      return !/^\[/.test(first) && !/=/.test(first) && PATH_SHAPED(first); // legacy file: a plain line is a toolchain name
    } catch { return true; }
  };
  for (let d = resolve(cwd), prev = ""; d !== prev; prev = d, d = dirname(d)) if (["rust-toolchain", "rust-toolchain.toml"].some((f) => lstatOk(join(d, f)) && doubtful(join(d, f)))) return true;
  return false;
}
/** The reason names the setting and the file, so an honest repo can see what to move out of the repo. */
export const cargoCompilerReason = (what: string, where: string): string => `test count could not be confirmed: ${what} in ${where} (move it to CARGO_HOME, or for a wrapper use the RUSTC_WRAPPER env)`;
/** Cut TOML `#` comments (outside quotes) so a commented-out key is not read as a setting. */
function stripTomlComments(t: string): string {
  return t.split("\n").map((line) => {
    let q = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === "#") return line.slice(0, i);
    }
    return line;
  }).join("\n");
}
/** An [env] table (or inline env table, or env.PATH key) that sets PATH lets rustc find the repo's own cc or ld. */
function cargoEnvSetsPath(t: string): boolean {
  if (/^\s*\[\s*env\s*\.\s*["']?PATH["']?\s*\]/m.test(t) || /(?:^|[\s,{])env\s*\.\s*["']?PATH["']?\s*[.=]/m.test(t)) return true;
  if (/(?:^|[\s,{])env\s*=\s*\{/m.test(t) && CARGO_KEY("PATH").test(t)) return true;
  let hdr = "";
  for (const line of t.split("\n")) {
    const h = /^\s*\[+\s*([^\[\]]*?)\s*\]+\s*$/.exec(line);
    if (h) hdr = h[1]!.replace(/["']/g, "");
    else if (hdr === "env" && /^\s*["']?PATH["']?\s*[.=]/.test(line)) return true;
  }
  return false;
}
const RUSTFLAGS_STRING = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*')`;
/** A rustflags entry with `link` (link-arg, link-args, linker, linker-flavor, link-self-contained), `-B`, `-Wl` or a codegen backend lets the repo pick the linker or load code into rustc. A bare `-C link-arg=-fuse-ld=<name>` (no path separator: mold, lld) is the one accepted form. */
function rustflagsReachLinker(t: string): boolean {
  const key = CARGO_KEY("rustflags"), n = (t.match(new RegExp(key.source, "gm")) ?? []).length;
  if (n === 0) return false;
  const vals = [...t.matchAll(new RegExp(String.raw`rustflags["']?\s*=\s*(\[(?:${RUSTFLAGS_STRING}|[^\]"'])*\]|${RUSTFLAGS_STRING})`, "g"))].map((m) => m[1]!);
  if (vals.length !== n) return true;
  return vals.some((v) => /link|-B|-Wl|codegen-backend/.test(v.replace(/link-arg=-fuse-ld=[A-Za-z0-9_.+-]+(?=["'\s,\]]|$)/g, "")));
}
/** The first setting in a cargo config text that lets the repo rewrite the test binary, as a label, or null. */
function compilerSettingIn(raw: string): string | null {
  const t = stripTomlComments(raw);
  for (const [k, label] of [["rustc", "build.rustc"], ["rustc-wrapper", "build.rustc-wrapper"], ["rustc-workspace-wrapper", "build.rustc-workspace-wrapper"], ["linker", "linker"]] as const) if (CARGO_KEY(k).test(t)) return label;
  if (cargoEnvSetsPath(t)) return "[env] PATH";
  if (rustflagsReachLinker(t)) return "rustflags with a link, -B, -Wl or codegen-backend flag";
  if (/\\[uU]/.test(t) || /^\s*include\s*=/m.test(t) || /"""|'''/.test(t)) return "an escaped key, include or multi-line string";
  return null;
}
/** The repo root: the nearest ancestor holding .git, else the highest ancestor holding a Cargo.toml, else the cwd. */
function cargoRepoRoot(cwd: string): string {
  let top: string | null = null;
  for (let d = resolve(cwd), prev = ""; d !== prev; prev = d, d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (existsSync(join(d, "Cargo.toml"))) top = d;
  }
  return top ?? resolve(cwd);
}
/** A manifest in the repo (cwd up to the root, any --manifest-path, and a bounded scan below the root) that turns on nightly profile-rustflags. */
function cargoProfileRustflagsManifest(root: string, cwd: string, toks: readonly string[]): string | null {
  const hit = (f: string): boolean => { try { return /cargo-features\s*=\s*\[[^\]]*profile-rustflags/.test(stripTomlComments(readFileSync(f, "utf8"))); } catch { return false; } };
  const seen = new Set<string>(), files: string[] = [];
  for (let d = resolve(cwd), prev = ""; d !== prev; prev = d, d = dirname(d)) { files.push(join(d, "Cargo.toml")); if (d === root) break; }
  toks.forEach((t, i) => { if (t === "--manifest-path") files.push(resolve(cwd, toks[i + 1] ?? "")); else if (t.startsWith("--manifest-path=")) files.push(resolve(cwd, t.slice(16))); });
  for (let stack: [string, number][] = [[root, 0]], seenDirs = 0; stack.length && seenDirs < 500; ) {
    const [d, depth] = stack.pop()!; seenDirs++;
    files.push(join(d, "Cargo.toml"));
    if (depth >= 5) continue;
    try { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !["target", ".git", "node_modules"].includes(e.name)) stack.push([join(d, e.name), depth + 1]); } catch { /* unreadable dir: skip */ }
  }
  for (const f of files) if (!seen.has(f)) { seen.add(f); if (existsSync(f) && hit(f)) return f; }
  return null;
}
/** A repo-committed cargo config that replaces the compiler (build.rustc), wraps it (build.rustc-wrapper, build.rustc-workspace-wrapper), sets a linker, reaches the linker through rustflags, or sets [env] PATH lets the repo rewrite the test binary after it is built, so both the run and its listing are the repo's own word. Read from a .cargo/config(.toml) in the cwd or any parent (the same walk as the runner check), a --config value or file, and a Cargo.toml that enables profile-rustflags. The CARGO_HOME / ~/.cargo config and the RUSTC_WRAPPER variable are NOT scanned, because sccache users set them and refusing would make honest runs PARTIAL; but only a .cargo directory strictly above the repo root is exempt, so a HOME inside the repo exempts nothing. A key written with a unicode escape, an `include`, a multi-line string, or an unreadable file is doubt. Returns the reason, which names the setting and the file. */
function cargoRepoCompilerRedirected(cwd: string, env: NodeJS.ProcessEnv, toks: readonly string[]): string | null {
  const root = cargoRepoRoot(cwd), rel = (f: string): string => { const r = relative(root, f); return r && !r.startsWith("..") && !isAbsolute(r) ? r : f; };
  const inFile = (f: string): string | null => { try { return compilerSettingIn(readFileSync(f, "utf8")); } catch { return "an unreadable config"; } };
  const vals = toks.flatMap((t, i) => (t === "--config" ? [toks[i + 1] ?? ""] : t.startsWith("--config=") ? [t.slice(9)] : []));
  for (const v of vals) {
    const inline = compilerSettingIn(v); if (inline) return cargoCompilerReason(inline, "--config");
    const f = resolve(cwd, v);
    if (existsSync(f) && lstatSync(f).isFile()) { const w = inFile(f); if (w) return cargoCompilerReason(w, v); }
  }
  const home = new Set([resolve(env["CARGO_HOME"] || join(env["HOME"] || homedir(), ".cargo")), resolve(homedir(), ".cargo")]);
  const aboveRoot = (dir: string): boolean => { const r = relative(dirname(dir), root); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  for (let d = resolve(cwd), prev = ""; d !== prev; prev = d, d = dirname(d)) {
    const dir = join(d, ".cargo");
    if (home.has(dir) && aboveRoot(dir)) continue;
    for (const f of ["config", "config.toml"]) if (existsSync(join(dir, f))) { const w = inFile(join(dir, f)); if (w) return cargoCompilerReason(w, rel(join(dir, f))); }
  }
  const m = cargoProfileRustflagsManifest(root, cwd, toks);
  return m ? cargoCompilerReason("cargo-features profile-rustflags", rel(m)) : null;
}
async function corroborateCargoPass(c: Classified, out: string, p: { global: string[]; rest: string[] }, o: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<Classified> {
  const refuse: Classified = { result: "not_run", reason: CARGO_UNLISTED_REASON }, dd = p.rest.indexOf("--"), notQuiet = (t: string): boolean => t !== "-q" && t !== "--quiet"; // --quiet at cargo level would also reach the listing and drop its "N tests" footer
  const lib = dd < 0 ? [] : p.rest.slice(dd + 1), argv = [...p.global.filter(notQuiet), "test", ...p.rest.slice(0, dd < 0 ? undefined : dd).filter(notQuiet), "--", ...lib.filter(notQuiet), "--list"];
  if (cargoToolchainRedirected(o.cwd, o.env)) return { result: "not_run", reason: CARGO_TOOLCHAIN_REASON };
  if (cargoRunnerConfigured(o.cwd, o.env, [...p.global, ...p.rest])) return { result: "not_run", reason: CARGO_RUNNER_REASON };
  const compilerWhy = cargoRepoCompilerRedirected(o.cwd, o.env, [...p.global, ...p.rest]);
  if (compilerWhy) return { result: "not_run", reason: compilerWhy };
  if (lib.some((t) => /^--(?:ignored|include-ignored|list|format|logfile)\b|^-Z/.test(t))) return refuse;
  const listing = async (extra: string[]): Promise<Set<string>[] | null> => {
    const r = await spawnCollect("cargo", [...argv, ...extra], { ...o, timeoutMs: 600_000 });
    if (r.status !== 0) return null;
    const blocks: Set<string>[] = []; let cur: string[] = [];
    for (const l of stripAnsi(r.output).split("\n")) { // stdout precedes stderr in the joined stream, so cargo's own notes never land inside a block
      const t = /^(\d+) tests?, (\d+) benchmarks?$/.exec(l), nm = /^(.+): (?:test|benchmark)$/.exec(l);
      if (t) { const set = new Set(cur); if (set.size !== cur.length || set.size !== +t[1]! + +t[2]!) return null; blocks.push(set); cur = []; } else if (nm) cur.push(nm[1]!);
    }
    return blocks;
  };
  const all = await listing([]), ign = await listing(["--ignored"]), segs = cargoSegs(cargoLines(stripAnsi(out)));
  if (!all || !ign || segs.length !== all.length || ign.length !== all.length) return refuse;
  return segs.every((g, k) => {
    const m = /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;/.exec(g.body[g.body.length - 1] ?? ""), L = all[k]!, I = ign[k]!;
    if (!m) return false;
    const { ok, ignored } = cargoNames(g.body.slice(0, -1));
    return g.n === L.size && +m[1]! + +m[2]! + +m[3]! + +m[4]! === L.size && +m[3]! === I.size && [...ok].every((x) => L.has(x) && !I.has(x)) && [...ignored].every((x) => I.has(x));
  }) ? c : refuse;
}
/** A Go -json pass is counted only after the tests are re-run (-count=1) with `-coverprofile` into a private temp file and that profile lists exactly the statement
 *  blocks the harness computed STATICALLY from the package source. Threat model: the go command hands the test binary its own -test.coverprofile=<build dir>/_cover_.out on
 *  argv (measured on go1.26) and copies that file into the harness path, and the binary itself emits the test2json framing (-test.v=test2json), so implementation or test code
 *  CAN write that file and print \x16-marked test2json lines, then leave through syscall.Exit(0); nothing the binary prints or writes is proof by itself. The expected block set
 *  comes from `go list` plus `go tool cover -mode=set` (it instruments source text and runs no user code), so the binary's profile must match
 *  file:line.col,line.col numStmt for every block of every non-test file of each passing package. A hand-written or truncated profile, a missing profile (early exit
 *  before the runtime writes it) and a package with no statements (checked per package), cgo files or a //line directive all stay not_run, the fail-safe default. The re-run must also exit 0 with a complete
 *  stream that passes the same tests. Argv or a plain `go test [-json] [-run X] <pkgs>` line only; any other shape (extra flags, shell syntax) cannot be re-run and stays
 *  not_run. A non-pass result is returned unchanged. Residual risk, stated plainly: code that reproduces the cover tool's block table for its own source can still forge. */
export async function corroboratePass(c: Classified, out: string, cmdOrLine: string, args: readonly string[] | undefined, o: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<Classified> {
  const toks = commandWords(cmdOrLine, args);
  if (c.result === "pass" && mentionsTool("cargo", cmdOrLine, args)) { // only a plain `cargo [globals] test|t` is corroborated; any other shape holding cargo (wrapper, shell, subshell, +toolchain, an alias) is refused, except a plain non-test subcommand
    const p = parseCargo(toks);
    if (p && p.sub === "test") return corroborateCargoPass(c, out, p, o); // the literal subcommand only: an alias (cargo t, or [alias] t = "run") can point it at main(), which prints a forged libtest summary
    if (!(p && CARGO_OTHER_SUBS.has(p.sub)) || /^test result:|^test \S.* \.\.\. ok\b/m.test(out)) return { result: "not_run", reason: CARGO_UNLISTED_REASON }; // run and bench execute the user's main(), whose libtest-shaped output is not a pass
  }
  if (c.result !== "pass" || goRunner(cmdOrLine, args).runner !== "go") return c;
  const g = corroborateGoSteps(c, out, cmdOrLine, args, toks, o); let step = g.next();
  while (!step.done) { const [cmd, a, to] = step.value; step = g.next(await spawnCollect(cmd, a, { ...to, ...(o.signal ? { signal: o.signal } : {}) })); }
  return step.value;
}
type SpawnRes = { status: number | null; output: string };
/** The same Go corroboration as corroboratePass, for the one synchronous caller (RealBaseTestRunner.run): identical steps, spawnSync driver. Go only; any other runner is returned unchanged. */
export function corroborateGoPassSync(c: Classified, out: string, cmdOrLine: string, args: readonly string[] | undefined, o: { cwd: string; env: NodeJS.ProcessEnv }): Classified {
  if (c.result !== "pass" || goRunner(cmdOrLine, args).runner !== "go") return c;
  const g = corroborateGoSteps(c, out, cmdOrLine, args, args ? [cmdOrLine, ...args] : cmdOrLine.trim().split(/\s+/), o); let step = g.next();
  while (!step.done) {
    const [cmd, a, to] = step.value, r = spawnSync(cmd, a, { cwd: to.cwd, env: to.env, timeout: to.timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }), res: SpawnRes = { status: r.error || r.signal ? null : r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
    step = g.next(res);
  }
  return step.value;
}
function* corroborateGoSteps(c: Classified, out: string, cmdOrLine: string, args: readonly string[] | undefined, toks: string[], o: { cwd: string; env: NodeJS.ProcessEnv }): Generator<[string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }], Classified, SpawnRes> {
  const refuse: Classified = { result: "not_run", reason: GO_EXIT0_REASON };
  const first = goJson(stripAnsi(out));
  const names = first?.passedNames ?? [];
  // argv has no shell, so metacharacters in it are inert; only the exact `-run ^(A|B)$` value runnerCmd builds from a file's Test names is let through, so a generated -run never refuses a real pass.
  const shellish = (t: string, i: number): boolean => /[&|;$`"'<>()\\]/.test(t) && !(args !== undefined && toks[i - 1] === "-run" && /^\^\([A-Za-z0-9_|]+\)\$$/.test(t));
  if (!names.length || toks.some(shellish) || basename(toks[0] ?? "") !== "go" || toks[1] !== "test") return refuse;
  const pkgs: string[] = [], run: string[] = [];
  for (let k = 2; k < toks.length; k++) {
    const t = toks[k]!;
    if (t === "-json") continue;
    if (t === "-run") { const v = toks[++k]; if (v === undefined) return refuse; run.push("-run", v); continue; }
    if (t.startsWith("-")) return refuse;
    pkgs.push(t);
  }
  const dir = mkdtempSync(join(tmpdir(), "loki-gocov-")), prof = join(dir, "cover.out"), where = pkgs.length ? pkgs : ["."];
  const spawnOpts = { cwd: o.cwd, env: o.env, timeoutMs: 600_000 };
  const profBlocks = (): Set<string> => { // the profile's blocks with counts dropped
    const set = new Set<string>();
    for (const l of (existsSync(prof) ? readFileSync(prof, "utf8") : "").split("\n")) { const m = /^(.+:\d+\.\d+,\d+\.\d+ \d+) \d+$/.exec(l); if (m) set.add(m[1]!); }
    return set;
  };
  try {
    const want = new Set(names.map((n) => n.slice(0, n.indexOf("::")))), expected = new Set<string>();
    const ls: SpawnRes = yield ["go", ["list", "-json=ImportPath,Dir,GoFiles,CgoFiles", ...where], spawnOpts];
    if (ls.status !== 0) return refuse;
    const perPkg = new Map<string, number>(); // statement blocks found per passing package; a package that stays at 0 (never listed, or no statements) has nothing to prove
    for (const chunk of ls.output.split(/\n(?=\{\n)/)) {
      let pk: { ImportPath?: string; Dir?: string; GoFiles?: string[]; CgoFiles?: string[] };
      try { pk = JSON.parse(chunk) as typeof pk; } catch { return refuse; }
      if (!pk.ImportPath || !want.has(pk.ImportPath)) continue;
      if (!pk.Dir || !pk.GoFiles?.length || pk.CgoFiles?.length) return refuse; // cgo files are rewritten by the go command, so their block table is not computable here: not_run (a genuine cgo package is a false not_run)
      perPkg.set(pk.ImportPath, 0);
      for (const f of pk.GoFiles) {
        if (/^\s*(?:\/\/line |\/\*line )/m.test(readFileSync(join(pk.Dir, f), "utf8"))) return refuse; // a //line directive (goyacc, ragel, templ) makes the profile name another file than the source: not provable, so not_run
        const t: SpawnRes = yield ["go", ["tool", "cover", "-mode=set", "-var=GoCoverStatic", join(pk.Dir, f)], spawnOpts];
        if (t.status !== 0) return refuse;
        const pos = /Pos: \[3 \* \d+\]uint32\{([^}]*)\}/.exec(t.output)?.[1] ?? "", stm = /NumStmt: \[\d+\]uint16\{([^}]*)\}/.exec(t.output)?.[1] ?? "";
        const trip = [...pos.matchAll(/(\d+), (\d+), (0x[0-9a-f]+),/g)], nums = [...stm.matchAll(/(\d+),/g)];
        if (trip.length !== nums.length) return refuse;
        perPkg.set(pk.ImportPath, perPkg.get(pk.ImportPath)! + trip.length);
        trip.forEach((m, k) => { const cols = +m[3]!; expected.add(`${pk.ImportPath}/${f}:${m[1]}.${cols & 0xffff},${m[2]}.${(cols >>> 16) & 0xffff} ${nums[k]![1]}`); });
      }
    }
    if (![...want].every((pk) => (perPkg.get(pk) ?? 0) > 0)) return refuse;
    const r: SpawnRes = yield ["go", ["test", "-json", "-count=1", `-coverprofile=${prof}`, ...run, ...where], spawnOpts];
    const second = goJson(stripAnsi(r.output));
    if (r.status !== 0 || !second || second.failed || !second.complete) return refuse;
    const again = new Set(second.passedNames);
    if (!names.every((n) => again.has(n))) return refuse;
    const got = [...profBlocks()].filter((k) => [...want].some((pk) => k.startsWith(`${pk}/`) && !k.slice(pk.length + 1).includes("/")));
    return got.length === expected.size && got.every((k) => expected.has(k)) ? c : refuse;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** Failing test ids a failed run names: go from the -json stream, cargo from "test x ... FAILED" lines that cover the trailer's failed count. [] = nothing readable (never red on its own). */
export function readableFailIds(runner: "go" | "cargo", out: string): string[] {
  const text = stripAnsi(out);
  if (runner === "go") return goJson(text)?.failedTests ?? [];
  const failed = cargoTrailer(text).reduce((t, l) => t + +(l.match(/(\d+) failed/)?.[1] ?? 0), 0);
  const ids = [...new Set(text.split("\n").flatMap((l) => { const m = /^test (.+?) \.\.\. FAILED$/.exec(l.trim()); return m ? [m[1]!] : []; }))];
  return failed > 0 && ids.length >= failed ? ids : [];
}
/** Executed-test count for a run whose `ran()` is null: node spec prints its failing-tests section after the summary block, so take the LAST
 *  pass and fail summary lines, not every one (A-112b: moved out of core engine10 verify.ts, no behaviour change). */
export function summaryPassFailCount(out: string): number {
  return (["pass", "fail"] as const).reduce((t, k) => t + +([...out.matchAll(new RegExp(`^(?:#|\\u2139) ${k} (\\d+)$`, "gm"))].pop()?.[1] ?? 0), 0);
}
/** Skipped or deselected tests from the runner's FINAL summary lines only: pytest "N skipped|deselected", jest/vitest "Tests: N skipped",
 *  node "# skipped N". Test names and captured output above the summary never count (A-115). */
export function skipped(raw: string): number {
  return stripAnsi(raw).split("\n").filter((l) => /^(?:=+ )?\d+ \w+.* in [\d.]+s|^\s*Tests?:?\s+\d|^(?:#|ℹ) skipped \d/.test(l.trim()))
    .reduce((t, l) => t + [...l.matchAll(/(\d+) (?:skipped|deselected|xfailed)|skipped (\d+)/g)].reduce((u, m) => u + +(m[1] ?? m[2]!), 0), 0);
}

/** HV1-03b: the executed/failed counts and failing ids of a Java run, from the build tool's own final report only. maven: the "Tests run:" aggregate that follows each "Results:" header, vouched by a closing BUILD line.
 *  gradle (-i): the "Class > method() PASSED|FAILED|SKIPPED" lines, vouched by BUILD SUCCESSFUL|FAILED. javac wrapper: the "LOKI_JAVA_TESTS: N run, M failed" line the wrapper prints last. A verdict that contradicts the
 *  counts, no vouching line, or no tests seen is null (unmeasured, never a pass). Skipped tests did not execute. */
export interface JavaSummary { executed: number; failed: number; ids: string[]; }
export function javaSummary(raw: string): JavaSummary | null {
  const ls = stripAnsi(raw).split("\n").map((l) => l.trimEnd()), tail = ls.filter((l) => l.trim()).slice(-40), ok = (re: RegExp): boolean | null => { const m = tail.map((l) => re.exec(l)).filter(Boolean).pop(); return m ? m[1] === "SUCCESS" || m[1] === "SUCCESSFUL" : null; };
  const wrap = ls.filter((l) => l.trim()).slice(-1)[0]?.match(/^LOKI_JAVA_TESTS: (\d+) run, (\d+) failed$/);
  if (wrap) { const ids = ls.flatMap((l) => l.match(/^FAIL (.+)$/)?.[1] ?? []), failed = +wrap[2]!; return +wrap[1]! > 0 && ids.length === failed && ls.filter((l) => /^(?:PASS|FAIL) /.test(l)).length === +wrap[1]! ? { executed: +wrap[1]!, failed, ids } : null; }
  const mv = ok(/^\[(?:INFO|ERROR)\] BUILD (SUCCESS|FAILURE)$/), gr = ok(/^BUILD (SUCCESSFUL|FAILED)\b/);
  if (mv !== null) {
    let executed = 0, failed = 0, seen = false;
    ls.forEach((l, i) => { if (/^\[(?:INFO|ERROR)\] Results:$/.test(l)) { const m = ls.slice(i + 1, i + 40).map((x) => /^\[(?:INFO|WARNING|ERROR)\] Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)$/.exec(x)).find(Boolean); if (m) { seen = true; executed += +m[1]! - +m[4]!; failed += +m[2]! + +m[3]!; } } });
    const ids = [...new Set(ls.flatMap((l) => { const m = /^\[ERROR\] (?:(\S+)\(([\w.$]+)\)|([\w.$]+\.[\w$]+)(?:\[[^\]]*\])?) .*<<< (?:FAILURE|ERROR)!$/.exec(l); return m ? [m[3] ?? `${m[2]}.${m[1]}`] : []; }))];
    return seen && executed > 0 && (mv ? failed === 0 : failed > 0) ? { executed, failed, ids } : null;
  }
  if (gr !== null) {
    const ev = ls.flatMap((l) => { const m = /^\s*(\S.*?) > (\S.*?) (PASSED|FAILED|SKIPPED)$/.exec(l); return m ? [{ id: `${m[1]}.${m[2]}`, s: m[3]! }] : []; }), bad = ev.filter((e) => e.s === "FAILED");
    const executed = ev.filter((e) => e.s !== "SKIPPED").length;
    return executed > 0 && (gr ? bad.length === 0 : bad.length > 0) ? { executed, failed: bad.length, ids: [...new Set(bad.map((e) => e.id))] } : null;
  }
  return null;
}
/** HV1-03b: the plain-javac runner for a Java repo with no build tool. It compiles src/main/java plus the one test file, runs the test class, and counts the "PASS <name>" / "FAIL <name>" lines the test printed, ending with the summary line javaSummary reads. The test's own exit status is kept, and the wrapper exits 1 when it counted any FAIL line (a test that printed FAIL but exited 0 is still red). */
const JAVAC_WRAPPER = `set -u
root="$1"; cls="$2"; shift 2; cd "$root" || exit 70
if [ "$cls" = "-" ]; then
  set -- $(find src/test/java -name '*Test.java' 2>/dev/null | sort); cls=""
  for f in "$@"; do c="\${f#src/test/java/}"; c="\${c%.java}"; cls="$cls \${c//\\//.}"; done
fi
out="$(mktemp -d "\${TMPDIR:-/tmp}/loki-javac.XXXXXX")" || exit 70
trap 'rm -rf -- "\${out:?}"' EXIT
find src/main/java -name '*.java' 2>/dev/null > "$out/srcs"
javac -nowarn -d "$out" @"$out/srcs" "$@" || exit 1
st=0; : > "$out/run.log"
for c in $cls; do java -cp "$out" "$c" >> "$out/run.log" 2>&1 || st=$?; done
cat "$out/run.log"
p=$(grep -c '^PASS ' "$out/run.log"); f=$(grep -c '^FAIL ' "$out/run.log")
echo "LOKI_JAVA_TESTS: $((p + f)) run, $f failed"
[ "$f" -gt 0 ] && st=1
exit $st`;
/** HV1-03b: "src/test/java/a/b/XTest.java" -> module root "." and class "a.b.XTest" (a test outside src/test/java is a default-package class named after its file). */
export function javaTestClass(path: string): { root: string; cls: string; rel: string } {
  const m = /^(.*?)\/?src\/test\/java\/(.+)\.java$/.exec(path), cls = (m ? m[2]! : basename(path, ".java")).split("/").join(".");
  return { root: m?.[1] || ".", cls, rel: m ? `src/test/java/${m[2]}.java` : path };
}
const wrapperOr = (repoDir: string, w: string, bare: string): string => (existsSync(join(repoDir, w)) ? `./${w}` : bare);

/** Count for the runners we support: vitest, jest, bun test ("N pass"), pytest, go test (-v; non-verbose is unmeasured), unittest, playwright, cargo test, node --test, mocha.
 *  null = unknown (never a pass). A vitest run with no files and no "Tests" summary is a real 0. */
export function testCount(raw: string, path?: string, ok?: boolean): number | null {
  const out = stripAnsi(raw);
  const bu = bunCount(out), ut = unittestCount(out, ok);
  if (bu !== null) return bu;
  if (ut !== null) return ut;
  const jv = javaSummary(out);
  if (jv) return jv.executed;
  if (/^\s*(?:Test Files\s+0\b|No test files found)/m.test(out) && !/^\s*Tests?\s+\d/m.test(out)) return 0;
  const r = ran(out, path, ok);
  if (r !== null) return r;
  const tl = tailLines(out);
  const pw = tl.filter((x) => /^\s*\d+ (?:passed|failed|flaky)\b/.test(x)); // Playwright: "N passed (2s)" trailer
  if (pw.length && tl.some((x) => /^\s*\d+ passed \([\d.]+m?s\)/.test(x) || /^\s*\d+ failed$/.test(x))) return pw.reduce((t, x) => t + +x.trim().split(" ")[0]!, 0);
  const lastNum = (re: RegExp): number | null => { const m = [...out.matchAll(re)].pop(); return m ? +m[1]! : null; };
  const mp = lastNum(/^\s*(\d+) passing\b/gm), mf = lastNum(/^\s*(\d+) failing\b/gm); // mocha: the LAST summary, never an earlier stdout line
  if (mp !== null || mf !== null) return (mp ?? 0) + (mf ?? 0);
  return null;
}

/** FC-FULL-SUITE-EXIT-CODED-SCRIPT: the receipt count text of a full-suite command that is a plain script (a CI checker), not a test runner. */
export const EXIT_CODED_COUNT = "n/a (exit-coded check, not a test runner)";
/** Any recognized test framework or test-script wrapper anywhere in the command. Conservative: a match means "framework". */
const FRAMEWORK_RE = /\b(?:pytest|py\.test|unittest|nose2?|tox|nox|jest|vitest|mocha|jasmine|ava|tap|playwright|cypress|karma|rspec|minitest|phpunit|pest|codeception|ctest|busted|prove)\b|\b(?:bun|deno|node|go|cargo|dotnet|swift|mix|dart|flutter|zig)\s+(?:[\w:.=-]+\s+)*test\b|\b(?:npm|pnpm|yarn|bun|npx)\b.*\btest|\b(?:mvn|mvnw|gradle|gradlew|ant|sbt|make|cmake|bazel|rake|composer|lein)\b|test/i;
const SCRIPT_RE = /^(?:python[\d.]*|node|bash|sh|ruby|perl)\s+(?:--?[\w-]+\s+)*([^\s-][^\s]*\.(?:py|js|mjs|cjs|sh|rb|pl))(?:\s|$)/;
/** True only when EVERY segment of the command is a plain interpreter-plus-script run (or a cd) and nothing in it names a test framework.
 *  Anything ambiguous (make, ./script, -m, -c, a path or word containing "test") is a framework, so it stays UNMEASURED when no summary parses. */
export function isExitCodedScript(cmd: string): boolean {
  const segs = cmd.replace(/[()]/g, " ").split(/&&|\|\||[;|\n]/).map((x) => x.trim()).filter(Boolean);
  let script = false;
  for (const raw of segs) {
    const seg = raw.replace(/^(?:(?:env|command|exec|time|nohup)\s+|[A-Za-z_]\w*=\S*\s+)+/, "").replace(/["']/g, "");
    if (/^cd\s+\S+$/.test(seg)) continue;
    if (FRAMEWORK_RE.test(seg) || !SCRIPT_RE.test(seg)) return false;
    script = true;
  }
  return script;
}
/** Stable failing id of an exit-coded script: the command plus a hash of its normalized failing output, or null when nothing is left to compare (a silent failure is never attributable).
 *  Normalized = ANSI stripped, the repo root prefix (and /private on macOS) plus its slash removed, line:col numbers removed, whitespace folded; the lines are a SORTED MULTISET (no dedupe),
 *  so an extra identical line is new. Repo-relative paths, other absolute paths and every other digit stay, so any new or changed finding is a different id (introduced). Recorded identically at the intake baseline and in the head full suite. */
export function exitCodedId(cmd: string, out: string, repoDir = ""): string | null {
  const roots = repoDir ? [`/private${repoDir}/`, `${repoDir}/`, `/private${repoDir}`, repoDir] : [];
  const norm = (x: string): string => roots.reduce((t, r) => t.split(r).join(""), x).replace(/(?<=\.[A-Za-z0-9]+):\d+(?::\d+)?/g, "").replace(/\s+/g, " ").trim();
  const lines = stripAnsi(out).split("\n").map(norm).filter(Boolean).sort();
  return lines.length ? `exit-coded:${cmd.trim()}:${createHash("sha256").update(lines.join("\n")).digest("hex")}` : null;
}
export interface ClassifyInput { kind: "test" | "static"; ok: boolean; cut?: boolean; missing?: boolean; out: string; path?: string; runner?: "go"; exitCoded?: boolean /* FC-FULL-SUITE-EXIT-CODED-SCRIPT: the command is a plain script (isExitCodedScript), decided by exit code like a static check */ }
export interface Classified { result: "pass" | "fail" | "not_run"; n?: number; reason?: string; count?: string }
/** A suite that discovered nothing: a parsed 0-test count with no skip, pending or todo wording left once explicit zero counts are removed. Skipped tests are not empty discovery (a change that skips the whole suite must never read as "nothing to run"). */
export function emptyDiscovery(cls: Classified, out: string): boolean {
  if (cls.result !== "not_run" || cls.n !== 0 || !/\bran 0 tests\b/.test(cls.reason ?? "")) return false;
  return !/skip|pending|todo/i.test(stripAnsi(out).replace(/\b0 (?:skipped|pending|todo)\b|\b(?:skipped|pending|todo)\W{1,3}0\b/gi, ""));
}
/** classifyCheck result plus the rerun-only "flaky" verdict (TEN-QUALITY-17); kept separate so existing classifyCheck callers keep the narrow type. */
export interface ClassifiedRerun extends Omit<Classified, "result"> { result: Classified["result"] | "flaky"; rerun?: { first: "fail"; second: "pass"; n?: number } }
/** One attempt of one check. static = lint/typecheck/scan (exit code decides, no count). test = a test runner: pass needs n>0. */
export function classifyCheck(i: ClassifyInput): Classified {
  if (i.missing) return { result: "not_run", reason: "tool not found on PATH" };
  if (i.cut) return { result: "not_run", reason: "timed out or aborted" };
  if (i.kind === "static") return { result: i.ok ? "pass" : "fail" };
  const text = stripAnsi(i.out);
  // Go: the count comes from text a test can forge, so it is never trusted. Exit 0 is never a pass from parsing; a failed run is a
  // fail only when the output shows real failure evidence, else unconfirmed. A parse problem never fails the code and never passes.
  if (i.runner === "go") { // chosen from the command, never from output text a test can print
    const j = goJson(text); // go test -json: a framed event stream
    if (i.ok) {
      if (!j || j.failed || !j.complete) return { result: "not_run", reason: GO_EXIT0_REASON }; // plain or -v output, a fail event under exit 0, or a torn stream: exit 0 alone is never a pass
      return j.passed > 0 ? { result: "pass", n: j.passed } : { result: "not_run", n: 0, reason: `${NO_TESTS_REASON} (ran 0 tests, empty or all skipped)` };
    }
    if (j) return j.failed ? { result: "fail" } : { result: "not_run", reason: UNCONFIRMED_REASON };
    // no usable -json stream (plain or -v output): exit 0 is never a pass from parsing; a failed run is a fail only with real failure evidence
    return FAIL_EVIDENCE.test(text) || GO_FAIL_EVIDENCE.test(text) ? { result: "fail" } : { result: "not_run", reason: UNCONFIRMED_REASON };
  }
  const n = testCount(i.out, i.path, i.ok);
  if (i.exitCoded && n === null) return { result: i.ok ? "pass" : "fail", count: EXIT_CODED_COUNT }; // only when no runner summary parses (a wrapper that prints a real summary keeps its count); never carries n: not executed-test proof
  if (!i.ok && FAIL_EVIDENCE.test(text)) return { result: "fail", ...(n !== null ? { n } : {}) }; // L2: a failure is never downgraded by a zero count
  if (n === 0) return { result: "not_run", n: 0, reason: `${NO_TESTS_REASON} (ran 0 tests, empty or all skipped)` };
  if (!i.ok) return { result: "fail", ...(n !== null ? { n } : {}) };
  if (n === null) return { result: "not_run", reason: UNMEASURED_REASON };
  const jv = javaSummary(text); if (jv && jv.failed > 0) return { result: "fail", n }; // HV1-03b: exit 0 with a Java report that counts failures contradicts itself; never a pass
  return { result: "pass", n };
}
/** TEN-QUALITY-17: a test check that fails and then passes on ONE immediate rerun is flaky, not fail, so fix rounds are not spent on it.
 *  Only a test whose first attempt classified fail is rerun (static, not_run and pass never are); a rerun that is not a pass keeps the first fail.
 *  flaky carries no n, so it is never executed proof (isExecutedProof needs result "pass"), exogenous or otherwise. */
export function classifyWithRerun(first: ClassifyInput, rerun: () => ClassifyInput): ClassifiedRerun {
  const a = classifyCheck(first);
  if (first.kind !== "test" || a.result !== "fail") return a;
  const b = classifyCheck(rerun());
  if (b.result !== "pass") return a;
  return { result: "flaky", reason: "failed once, passed on one immediate rerun", rerun: { first: "fail", second: "pass", ...(b.n !== undefined ? { n: b.n } : {}) } };
}
/** True when a check is Loki-executed proof: a pass with n>0. */
export const isExecutedProof = (c: { result?: unknown; n?: unknown }): boolean => c.result === "pass" && typeof c.n === "number" && c.n > 0;
/** Success-verdict gate: at least one executed check with n>0 and a pass. */
export const hasExecutedProof = (checks: ReadonlyArray<{ result?: unknown; n?: unknown }>): boolean => checks.some(isExecutedProof);

/** TEN-GATES-01 (FC-AGENT-PROOF): who authored the evidence behind a check. exogenous = lint/typecheck/static, scans, pre-existing suites, boot, probes;
 *  independent = a Wall file or the holdout; agent_authored = a runner on a path ADDED in the diff; llm_judge = council-style reviewers.
 *  Unknown names are exogenous (fail-closed toward the existing behaviour, same direction as proof-generator.py:286-292). Pure, no wiring. */
export type CheckProvenance = "exogenous" | "independent" | "agent_authored" | "llm_judge";
export interface ProvenanceCtx { addedFiles: readonly string[]; wallFiles: readonly string[]; holdout?: boolean; modifiedFiles?: readonly string[] } // modifiedFiles: pre-existing paths the run edited, deleted or renamed (TEN-GATES-17)
const LLM_JUDGES = new Set(["council", "xreview", "code_review", "devils_advocate", "magic_debate"]);
const NON_RUNNER = new Set(["lint", "typecheck", "holdout", "select-tests"]); // heads verify.ts emits that are not test runners
const normPath = (p: string): string => p.replace(/^(?:\.\/)+/, "");
export function checkProvenance(name: string, ctx: ProvenanceCtx): CheckProvenance {
  const head = name.split(":")[0]!;
  if (LLM_JUDGES.has(head)) return "llm_judge";
  if (head === "holdout") return "independent";
  if (!NON_RUNNER.has(head) && name.includes(":")) { // test checks are named `${runner}:${path}` (verify.ts testCheckName); any other head is a runner
    const p = normPath(name.slice(name.indexOf(":") + 1));
    if (ctx.wallFiles.some((w) => normPath(w) === p)) return "independent";
    if (ctx.addedFiles.some((a) => normPath(a) === p)) return "agent_authored";
    if (ctx.modifiedFiles?.some((m) => normPath(m) === p)) return "agent_authored"; // TEN-GATES-17: a pre-existing test the run edited is no longer the original proof (same direction as the A-119 edit rule)
  }
  return "exogenous";
}
/** True when some executed check (pass, n>0) is not backed solely by agent-authored or LLM-judge evidence. */
export const hasExogenousProof = (checks: ReadonlyArray<{ name?: string; result?: unknown; n?: unknown }>, ctx: ProvenanceCtx): boolean =>
  checks.some((c) => isExecutedProof(c) && ((p) => p !== "agent_authored" && p !== "llm_judge")(checkProvenance(c.name ?? "", ctx)));
/** FC-LEAN-VERIFIED-WITHOUT-CHANGED-SYMBOL: the extensions testmap.ts maps (JS/TS, Python, Go); verify and seal share it. */
export const CODE_FILE_EXT = /\.(?:[cm]?[jt]sx?|py|go)$/;
const DECL_RE = /\b(?:function\*?|def|class|fn|func|fun|type|interface|struct|enum|trait|object)\s+([A-Za-z_$][\w$]*)/g;
const VAR_DECL_RE = /^(?:export\s+(?:default\s+)?(?:declare\s+)?)?(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)/; // only at column 0: an indented const/let/var is a local, not a changed symbol
/** Drops comment text so a word in a comment is never a symbol or a test reference. Over-stripping only costs a false PARTIAL. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => (/^\s*\*/.test(l) ? "" : l.replace(/\/\/.*$/, "").replace(/(^|\s)#.*$/, "$1"))).join("\n");
const GO_METHOD_RE = /\bfunc\s*\([^)]*\)\s*([A-Za-z_]\w*)/g;
const METHOD_RE = /^\s*(?:(?:public|private|protected|static|async|export|override|final|abstract)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/;
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "with", "constructor"]);
const declNames = (line: string): string[] => {
  const out: string[] = [];
  const code = stripComments(line);
  for (const re of [DECL_RE, GO_METHOD_RE]) for (const m of code.matchAll(re)) out.push(m[1]!);
  const v = VAR_DECL_RE.exec(code);
  if (v) out.push(v[1]!);
  const m = METHOD_RE.exec(code);
  if (m) out.push(m[1]!);
  return out.filter((n) => !NOT_A_NAME.has(n));
};
/** Names a `git diff -U0` declares or modifies: declarations on added lines, plus the hunk's enclosing declaration (the @@ context) when the hunk removes lines or declares nothing itself. */
export function changedSymbols(diffU0: string): string[] {
  const out = new Set<string>();
  let ctx = "", added: string[] = [], removed = 0;
  const flush = (): void => {
    const own = stripComments(added.join("\n")).split("\n").flatMap(declNames); // strip over the whole hunk: a block comment can span added lines
    for (const n of own) out.add(n);
    if (removed > 0 || own.length === 0) for (const n of declNames(ctx)) out.add(n);
    added = []; removed = 0;
  };
  for (const line of diffU0.split("\n")) {
    if (line.startsWith("@@")) { flush(); ctx = line.replace(/^@@[^@]*@@\s?/, ""); }
    else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  flush();
  return [...out];
}
/** Symbols that no test source references as a whole word; every symbol when none is referenced, or when the diff declared none (then "(no declared symbol)"). Empty means some passing test source mentions a changed symbol. */
export function symbolGap(symbols: readonly string[], testSources: readonly string[]): string[] {
  if (symbols.length === 0) return ["(no declared symbol)"];
  const ref = (sym: string, src: string): boolean => new RegExp(`(?<![\\w$])${sym.replace(/[$]/g, "\\$")}(?![\\w$])`).test(src);
  const code = testSources.map(stripComments);
  return code.some((src) => symbols.some((sym) => ref(sym, src))) ? [] : [...symbols];
}
/** TEN-GATES-14: per-gate legibility for `loki verify --explain`. exogenous/independent evidence is exogenous; agent_authored and llm_judge are agent-influenced; absent or unknown provenance is unrecorded, never exogenous. */
export interface ExplainGate { name: string; class: "exogenous" | "agent-influenced" | "unrecorded"; provenance: string | null; result: string; n: number | null; evidence: string }
export function explainGates(receiptPath: string): ExplainGate[] {
  let checks: Array<Record<string, unknown>> = [];
  try { const c = (JSON.parse(readFileSync(receiptPath, "utf8")) as { checks?: unknown }).checks; if (Array.isArray(c)) checks = c.filter((x): x is Record<string, unknown> => !!x && typeof x === "object"); } catch { /* unreadable: no gates */ }
  return checks.map((c) => {
    const p = typeof c.provenance === "string" ? c.provenance : null;
    return { name: String(c.name ?? ""), class: p === "exogenous" || p === "independent" ? "exogenous" : p === "agent_authored" || p === "llm_judge" ? "agent-influenced" : "unrecorded", provenance: p, result: String(c.result ?? "not_run"), n: typeof c.n === "number" ? c.n : null, evidence: String(c.cmd ?? "") };
  });
}
export const printable = (s: string): string => s.replace(UNSAFE_TERMINAL_CHARS_RE, "?"); // receipt text never drives the terminal
/** What the receipt verifier saw: set once it resolves a run receipt and prints its verdict. */
export interface ExplainRec { runId?: string; receiptPath?: string; verdict?: string; reasons?: string[]; receiptSha256?: string | null; independent?: { k: number; of: number } | null; signingKid?: string | null; keyKid?: string | null; headSha?: string | null; receiptVerdict?: string | null; signedRunId?: string | null; signedSha?: string | null }
/** --explain lists each gate after the verdict; --json prints {run_id, run, verdict, exit_code, receipt_sha256, reasons, agent_independent:{k,of}, gates, signing_kid, key_kid, head_sha, receipt_verdict} on stdout (TEN-GATES-26; the last four are always the final keys, read from the parse the signature covers: the JWT header kid of a VERIFIED receipt, the --pubkey thumbprint, the receipt head_sha and verdict) with the human lines on stderr. Read-only: the exit code is the verifier's, unchanged; a TAMPERED receipt's gates are never listed. */
export async function withExplain(args: readonly string[], run: (args: readonly string[], rec: ExplainRec) => Promise<number>): Promise<number> {
  const explain = args.includes("--explain"), json = args.includes("--json");
  if (!explain && !json) return run(args, {});
  const mode = args.find((a) => /^--(export-dsse|seal-composite|sign-deploy|sign-provenance|url)(=|$)/.test(a)); // these print their own documents, not a receipt verdict
  if (mode) return (process.stderr.write(`loki verify: --explain and --json are not supported with ${mode.split("=")[0]}\n`), 2);
  const rec: ExplainRec = {}, w = process.stdout.write;
  if (json) process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let code: number;
  try { code = await run(args.filter((a) => a !== "--explain" && a !== "--json"), rec); } finally { if (json) process.stdout.write = w; }
  if (!rec.receiptPath || !rec.verdict) return (process.stderr.write("loki verify: --explain and --json apply to a run receipt only; nothing explained\n"), code);
  const gates = rec.verdict === "TAMPERED" ? null : explainGates(rec.receiptPath);
  if (json) return (process.stdout.write(`${JSON.stringify({ run_id: rec.runId ?? null, run: rec.runId ?? null, verdict: rec.verdict, exit_code: code, receipt_sha256: rec.receiptSha256 ?? null, reasons: rec.reasons ?? [], agent_independent: rec.verdict === "TAMPERED" ? null : rec.independent ?? null, gates, signing_kid: rec.verdict === "TAMPERED" ? null : rec.signingKid ?? null, key_kid: rec.verdict === "TAMPERED" ? null : rec.keyKid ?? null, head_sha: rec.verdict === "TAMPERED" ? null : rec.headSha ?? null, receipt_verdict: rec.verdict === "TAMPERED" ? null : rec.receiptVerdict ?? null, signed_run_id: rec.verdict === "TAMPERED" ? null : rec.signedRunId ?? null, signed_sha256: rec.verdict === "TAMPERED" ? null : rec.signedSha ?? null })}\n`), code);
  if (!gates) return (process.stdout.write("explain: receipt TAMPERED; its gates are untrusted and not listed\n"), code);
  process.stdout.write(`explain: ${gates.length} gate${gates.length === 1 ? "" : "s"} (exogenous: evidence the agent could not shape; agent-influenced: agent-authored test or LLM judge; unrecorded: no provenance)\n`);
  for (const g of gates) process.stdout.write(`  gate ${printable(g.name)}: ${g.class} (provenance ${g.provenance === null ? "not recorded" : printable(g.provenance)}), result ${printable(g.result)}, n ${g.n ?? "-"}, evidence: ${printable(g.evidence) || "-"}\n`);
  return code;
}

// RISKTIER: classify risk on the ARTIFACT (the actual diff), never the prompt, and map the tier to a verification plan.
// The bash `loki review --risk` scorer (autonomy/lib/review_risk.py) stays a separate 0-100 advisory view.
export type RiskTier = "low" | "medium" | "high";
export interface DiffFile { path: string; added: number; deleted: number; status?: "added" | "modified" | "deleted"; deps?: boolean /* set by diffFiles for a dependency manifest whose dependency set changed */; critical?: string /* set by diffFiles: the repo-derived rule (CODEOWNERS, .loki/config.json critical_paths, or an added publish/push/signing/credential line) that makes this file critical */ }
export interface RiskOverride { from: RiskTier; to: RiskTier; reason: string }
export interface RiskAssessment {
  version: 1; tier: RiskTier; computed: RiskTier; reasons: string[];
  stats: { files: number; lines: number; sensitive: string[]; critical?: string[]; tests_modified: string[]; tests_deleted: string[]; api: string[] };
  checks_selected: string[]; checks_deferred: string[]; // deferred = planned for this tier but NOT run by the fast verify stage; never a pass
  override?: RiskOverride; override_ignored?: string; advisories?: string[]; summary: string;
}

const SENSITIVE: [string, RegExp][] = [
  ["auth", /(^|\/)(auth|oauth|sso|session|login|permission|rbac|acl)[\w.-]*(\/|\.|$)/i],
  ["crypto", /(^|\/)(crypt|crypto|jwt|signing|keys?|secrets?|tokens?|credential|password)[\w.-]*(\/|\.|$)/i],
  ["payments", /(^|\/)(payments?|billing|checkout|stripe|invoice)[\w.-]*(\/|\.|$)/i],
  ["migration", /(^|\/)(migrations?|alembic)\/|\.sql$/i],
  ["ci", /(^|\/)(\.github\/(workflows|actions)|\.gitlab-ci\.yml|\.circleci|Jenkinsfile|azure-pipelines)/i],
  ["lockfile", /(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|go\.sum|[\w-]+\.lock)$/],
  ["infra", /(^|\/)(Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|terraform|helm|k8s|kubernetes|infra|deploy)(\/|\.|$)|\.tf$/i],
  ["env", /(^|\/)\.env[\w.]*$/],
];
const API: RegExp = /(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$|\.proto$|\.d\.ts$|(^|\/)(api|routes|public)\/|(^|\/)index\.(ts|js|py)$/i;
const TEST_CFG = /(^|\/)(conftest\.py|\.?pytest\.(ini|toml)|tox\.ini|jest\.config\.[\w.]+|vitest\.config\.[\w.]+)$/;
const RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };
const FILES_MEDIUM = 4, FILES_HIGH = 15, LINES_MEDIUM = 100, LINES_HIGH = 500;

// Fast verify always runs targeted tests and lint of changed files; anything else in `selected` is required depth.
const RAN_ALWAYS = ["targeted tests", "lint of changed files"];
export const REVIEWER_ITEM = "one reviewer";
const PLAN: Record<RiskTier, { selected: string[] }> = {
  low: { selected: [...RAN_ALWAYS] },
  medium: { selected: [...RAN_ALWAYS, "full test command", REVIEWER_ITEM] },
  high: { selected: [...RAN_ALWAYS, "full test command", "full suite", "council", "security scan"] },
};
const LOW_SKIPPED = ["full test command", "reviewer", "council", "security scan"]; // low skips these by design; they are listed so the record never implies they ran
const deferredOf = (tier: RiskTier, selected: string[], executed: string[]): string[] => (tier === "low" ? LOW_SKIPPED : selected).filter((c) => !RAN_ALWAYS.includes(c) && !executed.includes(c));

function summaryOf(a: Pick<RiskAssessment, "tier" | "computed" | "reasons" | "override" | "checks_deferred">): string {
  const why = a.tier === a.computed ? a.reasons.slice(0, 2).join("; ") : `computed ${a.computed}; override ${a.override?.from} to ${a.override?.to}: ${a.override?.reason}`;
  const def = a.checks_deferred;
  return `risk: ${a.tier} (${why}), ${def.length ? def.join(", ") : "no deeper checks"} not run`;
}

export const DEEP_ITEMS = ["full suite", "app boot", "council", "security scan"] as const;
export const NOT_SELECTED = "not selected by risk tier: ";
/** FC-SEAL-NA-AS-UNPROVEN: the deep checks a receipt lists as NOT PROVEN (the tier wanted them and they did not run) versus "not selected by risk tier" (the tier never asked). No usable risk record keeps every item NOT PROVEN (fail-safe); a full suite that verify executed is dropped. */
export function deepGaps(risk: unknown, verifyChecks: { name?: unknown; result?: unknown }[], deepChecks: { name?: unknown; result?: unknown }[] = [], reviewRan = false): { notProven: string[]; notSelected: string[] } {
  const r = risk as { tier?: unknown; checks_selected?: unknown; checks_deferred?: unknown } | null | undefined, arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const ok = !!r && (r.tier === "low" || r.tier === "medium" || r.tier === "high") && Array.isArray(r.checks_selected) && Array.isArray(r.checks_deferred);
  const executed = (cs: { name?: unknown; result?: unknown }[], i: string): boolean => cs.some((c) => String(c.name).startsWith(i) && (c.result === "pass" || c.result === "fail"));
  const sel = ok ? arr(r?.checks_selected) : [], fullRan = executed(verifyChecks, "full suite") || (sel.includes("full test command") && !arr(r?.checks_deferred).includes("full test command"));
  const items = DEEP_ITEMS.filter((i) => !(i === "full suite" ? fullRan : false) && !executed(deepChecks, i));
  if (!ok) return { notProven: [...items], notSelected: [] };
  const low = r?.tier === "low", gap = (i: string): boolean => !low && (i === "full suite" ? sel.includes("full test command") || sel.includes("full suite") : sel.includes(i));
  const notProven = items.filter(gap), notSelected = items.filter((i) => !gap(i)).map((i) => NOT_SELECTED + i);
  const reviewed = reviewRan || executed(deepChecks, "council"); // FC-MEDIUM-REVIEWER-UNCREDITED: "one reviewer" is credited only by a review that really ran (seal's cross-review verdict, or the deep reviewer session); never by tier alone
  for (const d of arr(r?.checks_deferred).filter((x) => !(DEEP_ITEMS as readonly string[]).includes(x) && !(x === REVIEWER_ITEM && reviewed))) (low ? notSelected : notProven).push(low ? NOT_SELECTED + d : d);
  return { notProven, notSelected };
}

/** Marks selected deeper checks that verify really executed (for example the full test command), then rebuilds deferred and summary. */
export function markExecuted(a: RiskAssessment, executed: string[]): RiskAssessment {
  const checks_deferred = deferredOf(a.tier, a.checks_selected, executed);
  return { ...a, checks_deferred, summary: summaryOf({ ...a, checks_deferred }) + (a.advisories?.length ? `; advisory: ${a.advisories.join(", ")}` : "") };
}

// TEN-GATES-18: advisory only. A dependency manifest whose dependency set changed with no lockfile change beside it (same or ancestor dir) is flagged; it never alters the tier.
const MANIFEST_LOCKS: [RegExp, RegExp][] = [
  [/(^|\/)package\.json$/, /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/],
  [/(^|\/)pyproject\.toml$/, /(^|\/)(poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock)$/],
  [/(^|\/)go\.mod$/, /(^|\/)go\.sum$/],
];
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const PKG_DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const PYPROJECT_NONDEP = /^(name|version|description|readme|license|requires-python|python|authors|maintainers|keywords|classifiers|homepage|repository|documentation|packages|include|exclude)$/;

/** Pure: did the dependency set of this manifest change? package.json compares the four dependency maps (scripts-only edits are false); go.mod and pyproject.toml read the -U0 patch. Unparseable package.json counts as changed. */
export function manifestDepsChanged(path: string, oldText: string, newText: string, patch: string): boolean {
  if (/(^|\/)package\.json$/.test(path)) {
    try {
      const o = oldText.trim() ? JSON.parse(oldText) : {}, n = newText.trim() ? JSON.parse(newText) : {};
      return PKG_DEP_KEYS.some((k) => JSON.stringify(o?.[k] ?? {}) !== JSON.stringify(n?.[k] ?? {}));
    } catch { return true; }
  }
  const changed = patch.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  if (/(^|\/)go\.mod$/.test(path)) return changed.some((l) => { const b = l.slice(1).trim(); return b !== "" && !b.startsWith("//") && !/^(module|go|toolchain)\b/.test(b); });
  return changed.some((l) => {
    const b = l.slice(1).trim();
    if (/^"[A-Za-z][\w.-]*(\[[\w,.-]+\])?\s*([<>=~!]|;|@|"\s*,?\s*$)/.test(b)) return true; // PEP 508 list entry
    const m = /^([A-Za-z][\w.-]*)\s*=\s*("[\^~<>=!*\d]|\{[^}]*version)/.exec(b); // poetry-style name = "^1.0"
    return !!m && !PYPROJECT_NONDEP.test(m[1]!);
  });
}

/** Pure: manifests with changed dependencies and no matching lockfile in the same or an ancestor directory of the diff. */
export function manifestsWithoutLock(files: DiffFile[]): string[] {
  return files.filter((f) => f.deps && f.status !== "deleted").flatMap((f) => {
    const pair = MANIFEST_LOCKS.find(([m]) => m.test(f.path)); if (!pair) return [];
    const d = dirOf(f.path);
    const locked = files.some((g) => pair[1].test(g.path) && (dirOf(g.path) === "" || d === dirOf(g.path) || d.startsWith(dirOf(g.path) + "/")));
    return locked ? [] : [f.path];
  });
}

// FC-CRITICAL-CLASS-GRADED-LOW: critical paths come from the repo itself (CODEOWNERS entries, .loki/config.json critical_paths) and from what the diff adds
// (a push, publish, signing or credential call), never from a list of one repo's paths. SENSITIVE above stays the generic name heuristic.
const SEM_RULES: [string, RegExp][] = [
  ["git push", /\bgit\s+(-\S+\s+)*push\b/],
  ["publish command", /\b(npm|pnpm|yarn|bun)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bdocker\s+push\b|\bgh\s+release\s+create\b|\bgem\s+push\b/],
  ["signing call", /\bcosign\s+sign\b|\bjwt\.sign\(|\bcreateSign\(|\bcreateHmac\(|\bhmac\.new\(|\bgpg\b[^\n]*--(detach-)?sign\b|\bminisign\s+-S\b/i],
  ["credential or token", /\bAuthorization:\s*(Bearer|token)\b|\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*\S/i],
];
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i;
/** gitignore-style glob to RegExp: a pattern with a "/" anchors at the root, one without matches any basename, trailing "/" is a directory. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim(); const anchored = g.replace(/\/$/, "").includes("/"), dir = g.endsWith("/");
  g = g.replace(/^\//, "").replace(/\/$/, "");
  const body = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\/\*\*/g, "\u0002").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0001/g, "(.*/)?").replace(/\u0002/g, "(/.*)?");
  return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${dir ? "/" : "($|/)"}`);
}
/** Pure: critical globs with their source label. CODEOWNERS text: the first token of each non-comment line; the match-everything "*" is skipped (it would grade every change critical). */
export function criticalRulesFrom(codeowners: string | null, configJson: string | null): { glob: string; source: string }[] {
  const out: { glob: string; source: string }[] = [];
  for (const l of (codeowners ?? "").split("\n")) { const t = l.replace(/#.*/, "").trim().split(/\s+/)[0] ?? ""; if (t && !/^(\/?\*{1,2}|\/)$/.test(t)) out.push({ glob: t, source: `CODEOWNERS ${t}` }); }
  try { const c = (JSON.parse(configJson ?? "null") as { critical_paths?: unknown } | null)?.critical_paths; if (Array.isArray(c)) for (const g of c) if (typeof g === "string" && g.trim()) out.push({ glob: g, source: `.loki/config.json critical_paths ${g}` }); } catch { /* unreadable config: CODEOWNERS and diff rules still apply */ }
  return out;
}
const readOr = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const OWNER_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
/** Rules come from the BASE tree when baseSha is given: a diff must not be able to empty, delete or shadow the files that grade it. Without a readable base the working tree is used. */
export function criticalRules(repoDir: string, baseSha?: string): { glob: string; source: string }[] {
  const read = (p: string): string | null => {
    if (!baseSha) return readOr(join(repoDir, p));
    try { return safeGit(repoDir, ["show", `${baseSha}:${p}`]); } catch { return null; }
  };
  const co = OWNER_FILES.map(read).find((t) => t !== null) ?? null;
  return [
    ...criticalRulesFrom(co, read(".loki/config.json")),
    // editing the grading inputs is itself critical, whatever they said before
    ...OWNER_FILES.map((g) => ({ glob: `/${g}`, source: `ownership file ${g} changed` })),
    { glob: "/.loki/config.json", source: "critical-paths config .loki/config.json changed" },
  ];
}
// Generic path tokens that name a trust boundary in any repo (split on / . _ -): releasing, publishing, signing, auth, security, sealing, verifying.
const CRITICAL_TOKENS = /^(release|publish|sign|signing|signer|auth|security|seal|verif\w*)$/i;
const criticalToken = (path: string): string | undefined => path.split(/[\/._-]+/).find((t) => CRITICAL_TOKENS.test(t));
/** Pure: the rule that makes a file critical, or undefined. Path rules first, then what the file's added text does. Docs and test files are not graded by their text. */
export function criticalRuleFor(path: string, addedText: string, rules: { glob: string; source: string }[]): string | undefined {
  const hit = rules.find((r) => { try { return globToRegExp(r.glob).test(path); } catch { return false; } });
  if (hit) return hit.source;
  if (DOC_FILE.test(path) || isTestFile(path)) return undefined;
  const tok = criticalToken(path); if (tok) return `path names a trust boundary (${tok})`;
  const sem = SEM_RULES.find(([, re]) => re.test(addedText));
  return sem ? `added ${sem[0]}` : undefined;
}

export function classifyRisk(files: DiffFile[], env: NodeJS.ProcessEnv = process.env): RiskAssessment {
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const sensitive = files.flatMap((f) => { const hit = SENSITIVE.find(([, re]) => re.test(f.path)); return hit && !isTestFile(f.path) ? [`${f.path} (${hit[0]})`] : []; });
  const testFiles = files.filter((f) => isTestFile(f.path));
  const testsDeleted = testFiles.filter((f) => f.status === "deleted").map((f) => f.path);
  const testsModified = [...testFiles.filter((f) => f.status !== "added" && f.status !== "deleted").map((f) => f.path), ...files.filter((f) => TEST_CFG.test(f.path)).map((f) => f.path)];
  const api = files.filter((f) => API.test(f.path) && !isTestFile(f.path)).map((f) => f.path);
  const high: string[] = [], med: string[] = [];
  const critical = files.filter((f) => f.critical).map((f) => `${f.path} (${f.critical})`);
  if (critical.length) high.push(`critical class: ${critical.slice(0, 3).join(", ")}${critical.length > 3 ? ` (+${critical.length - 3})` : ""}`);
  if (sensitive.length) high.push(`sensitive paths: ${sensitive.slice(0, 5).join(", ")}${sensitive.length > 5 ? ` (+${sensitive.length - 5})` : ""}`);
  if (testsDeleted.length) high.push(`test files deleted: ${testsDeleted.join(", ")}`);
  if (api.length) high.push(`public API surface: ${api.slice(0, 3).join(", ")}`);
  if (files.length >= FILES_HIGH) high.push(`${files.length} files >= ${FILES_HIGH}`);
  if (lines >= LINES_HIGH) high.push(`${lines} changed lines >= ${LINES_HIGH}`);
  if (testsModified.length) med.push(`existing tests or test config modified: ${testsModified.slice(0, 3).join(", ")}`);
  if (files.length >= FILES_MEDIUM) med.push(`${files.length} files >= ${FILES_MEDIUM}`);
  if (lines >= LINES_MEDIUM) med.push(`${lines} changed lines >= ${LINES_MEDIUM}`);
  const computed: RiskTier = high.length ? "high" : med.length ? "medium" : "low";
  const reasons = high.length ? [...high, ...med] : med.length ? med : [`${files.length} file${files.length === 1 ? "" : "s"}, no sensitive paths`];

  // A prompt or flag may RAISE the tier freely. Lowering needs an explicit recorded reason; high is never lowered silently.
  let tier = computed, override: RiskOverride | undefined, ignored: string | undefined;
  const asked = (env["LOKI_RISK_TIER"] ?? "").trim().toLowerCase() as RiskTier;
  if (asked in RANK && asked !== computed) {
    const reason = (env["LOKI_RISK_OVERRIDE_REASON"] ?? "").trim();
    if (RANK[asked] > RANK[computed]) { tier = asked; override = { from: computed, to: asked, reason: reason || "raised by LOKI_RISK_TIER" }; }
    else if (reason) { tier = asked; override = { from: computed, to: asked, reason }; }
    else ignored = `LOKI_RISK_TIER=${asked} ignored: lowering from ${computed} needs LOKI_RISK_OVERRIDE_REASON`;
  }
  const plan = PLAN[tier], checks_deferred = deferredOf(tier, plan.selected, []);
  const advisories = manifestsWithoutLock(files).map((p) => `manifest changed without lockfile: ${p}`);
  const summary = summaryOf({ tier, computed, reasons, ...(override ? { override } : {}), checks_deferred }) + (advisories.length ? `; advisory: ${advisories.join(", ")}` : "");
  return {
    version: 1, tier, computed, reasons,
    stats: { files: files.length, lines, sensitive, ...(critical.length ? { critical } : {}), tests_modified: testsModified, tests_deleted: testsDeleted, api },
    checks_selected: plan.selected, checks_deferred,
    ...(override ? { override } : {}), ...(ignored ? { override_ignored: ignored } : {}), ...(advisories.length ? { advisories } : {}), summary,
  };
}

/** FC-WALL-LOCATION-BLIND: a loki_wall_* file in the tree that this run's Wall did not install (an earlier run left it untracked, or this run discarded it) is not a change of this run: verifying it would credit an exogenous pass for a test the receipt lists as discarded. `own` holds the paths this run installed (absolute or repo-relative). */
export const withoutStaleWall = <T extends string | { path: string }>(items: T[], own: string[], repoDir: string): T[] => { const mine = new Set(own.map((p) => (isAbsolute(p) ? relative(repoDir, p) : p))); return items.filter((it) => { const f = typeof it === "string" ? it : it.path; return !/(^|\/)loki_wall_[^/]*$/.test(f) || mine.has(f); }); };
/** FC-VERIFIED-PR-WITHOUT-ITS-TEST: the Wall files verify ran and passed (target_checks + executed proof), as their SEALED bytes: the runDir/wall copy must hash to wall.files[].sha256, else a NOT PROVEN note and no file. LOKI_COMMIT_WALL=0: none published. clauseGap (FALSEVER-CLAUSE) is read from the same passing sealed copies whatever that switch says: the spec clauses none of them proves, empty when no task text is given or no Wall file ran. */
export function publishableWall(repoDir: string, runDir: string, o: Partial<Record<string, Record<string, unknown>>>, env: NodeJS.ProcessEnv = process.env, task?: string): { files: { rel: string; bytes: Buffer; cmd: string; runner: string }[]; notes: string[]; clauseGap: string[]; weak: string[] } {
  const out = { files: [] as { rel: string; bytes: Buffer; cmd: string; runner: string }[], notes: [] as string[], clauseGap: [] as string[], weak: [] as string[] }, arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []), tgt = new Set(Array.isArray(o.verify?.["target_checks"]) ? (o.verify["target_checks"] as unknown[]).map(String) : []);
  const listed = arr(o.wall?.["files"]);
  for (const w of listed) {
    const rel = relative(repoDir, String(w["path"])), hit = arr(o.verify?.["checks"]).find((c) => tgt.has(String(c["name"])) && String(c["name"]).slice(String(c["name"]).indexOf(":") + 1) === rel && hasExecutedProof([c]));
    if (!hit || rel.startsWith("..") || isAbsolute(rel) || rel.startsWith(".loki/") || !basename(rel).startsWith("loki_wall_")) continue; // stale, failed, not-run or outside the repo: stays dropped
    try { const bytes = readFileSync(sealedWallCopy(runDir, rel)); if (createHash("sha256").update(bytes).digest("hex") !== w["sha256"]) throw new Error("hash"); out.files.push({ rel, bytes, cmd: String(hit["cmd"]), runner: String(hit["name"]).slice(0, String(hit["name"]).indexOf(":")) }); } catch { out.notes.push(`Wall test not published: ${rel} (sealed copy missing or not the sealed bytes)`); }
  }
  if (task !== undefined && listed.length > 0) out.clauseGap = clauseGapOf(extractClauses(task), out.files.map((f) => f.bytes.toString("utf8")));
  const weak = weakAssertionNote(out.files.map((f) => ({ rel: f.rel, body: f.bytes.toString("utf8") }))); if (weak) out.weak = [weak];
  if (env["LOKI_COMMIT_WALL"] === "0") { out.files = []; out.notes = []; }
  return out;
}
/** Why a sealed Wall path cannot be written into repoDir: it leaves the repo, or it is, or sits under, a symlink or non-directory (a link committed by another unit must not redirect a write). null = safe. */
export function wallPathProblem(repoDir: string, relPath: string): string | null {
  const rel = normalize(relPath);
  if (isAbsolute(rel) || rel.split(sep).includes("..")) return `Wall path outside the repo: ${relPath}`;
  let cur = repoDir;
  for (const part of dirname(rel) === "." ? [] : dirname(rel).split(sep)) { cur = join(cur, part); try { const st = lstatSync(cur); if (st.isSymbolicLink() || !st.isDirectory()) return `Wall path crosses a symlink or non-directory: ${relPath}`; } catch { return null; } }
  try { return lstatSync(join(repoDir, rel)).isSymbolicLink() ? `Wall path is a symlink: ${relPath}` : null; } catch { return null; }
}
export interface SealedWallFile { rel: string; bytes: Buffer; runner?: RunnerName }
/** Reads a unit's sealed Wall as the receipt recorded it: each runDir/wall/<name> copy must hash to receipt.wall.files[].sha256, else a problem (the caller treats it as a failing Wall). Same sources as publishableWall and verify's wallTamperProblem. */
export function loadSealedWall(runDir: string, unitRepoDir: string): { files: SealedWallFile[]; problems: string[]; receiptMissing?: true } {
  const files: SealedWallFile[] = [], problems: string[] = [];
  let listed: unknown;
  try { listed = (JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")) as { wall?: { files?: unknown } }).wall?.files; } catch { return { files, problems, receiptMissing: true }; } // missing or unreadable receipt: nothing was sealed to rerun, so the group is NOT_PROVEN, not FAILED
  for (const w of Array.isArray(listed) ? (listed as { path?: unknown; sha256?: unknown; runner?: unknown }[]) : []) {
    const rel = typeof w?.path === "string" ? relative(unitRepoDir, w.path) : "";
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) { problems.push(`sealed Wall path outside the repo: ${String(w?.path)}`); continue; }
    try {
      const bytes = readFileSync(join(runDir, "wall", basename(rel)));
      if (createHash("sha256").update(bytes).digest("hex") !== w.sha256) throw new Error("hash");
      files.push({ rel, bytes, ...(typeof w.runner === "string" ? { runner: w.runner as RunnerName } : {}) });
    } catch { problems.push(`sealed Wall copy ${basename(rel)} missing or not the sealed bytes`); }
  }
  return { files, problems };
}

/** GAME10-06a: each integrated unit's sealed Wall, read from the harvested unit run dir. The unit worktree (where the receipt's Wall paths point) is named by the receipt itself, falling back to the backlog worktree for the branch. */
export function unitWalls(repoDir: string, gid: string, branches: Record<string, string>): Record<string, ReturnType<typeof loadSealedWall>> {
  const out: Record<string, ReturnType<typeof loadSealedWall>> = {};
  for (const [id, br] of Object.entries(branches)) {
    const runDir = join(repoDir, ".loki", "groups", gid, "group", "units", id);
    let root = `${repoDir}-backlog/${br.replace(/^loki\//, "")}`;
    try {
      const f = ((JSON.parse(readFileSync(join(runDir, "receipt.json"), "utf8")) as { wall?: { files?: { path?: unknown }[] } }).wall?.files ?? [])[0]?.path;
      const m = typeof f === "string" ? /^(.*-backlog\/unit-[^/]+-\d+)\//.exec(f) : null;
      if (m) root = m[1]!;
    } catch { /* unreadable receipt: loadSealedWall reports it */ }
    out[id] = loadSealedWall(runDir, root);
  }
  return out;
}

/** Tracked changes against baseSha, plus untracked new files (commit runs after verify). `.loki/`
 *  is filtered defensively even though intake also excludes it via .git/info/exclude. Throws if
 *  either git command fails: a broken baseSha must never read as "nothing changed" (~ALREADY_SATISFIED). */
export function changedFiles(repoDir: string, baseSha: string, skip?: (f: string) => boolean): string[] {
  const run = (args: string[]): string[] =>
    safeGit(repoDir, args)
      .split("\0").filter(Boolean); // FC-CHANGED-PATH-QUOTED: -z plus quotePath=false, so a non-ASCII path is its real name, never a quoted escape
  const tracked = run(["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", baseSha]);
  const untracked = run(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...tracked, ...untracked])].filter((f) => !f.startsWith(".loki/") && !skip?.(f)); // skip: install-owned paths (FC-DEPS-NOT-INSTALLED)
}

/** The skip-worktree paths that the effective sparse-checkout patterns genuinely exclude. core.sparseCheckout alone proves nothing (the
 *  implementer sets repo config), so the pattern file is evaluated by git itself: its lines are gitignore-syntax with last-match-wins, so a
 *  scratch repo takes them as info/exclude and `check-ignore --no-index` names the INCLUDED paths. Config off, file unreadable or any error
 *  yields the empty set (fail closed: the deletion is reported). Known limit: an implementer who writes a pattern file excluding the path
 *  is indistinguishable from a real sparse checkout. */
function sparseExcluded(repoDir: string, tmp: string, paths: string[]): Set<string> {
  try {
    if (safeGit(repoDir, ["config", "--type=bool", "--get", "core.sparseCheckout"]).trim() !== "true") return new Set();
    const rel = safeGit(repoDir, ["rev-parse", "--git-path", "info/sparse-checkout"]).trim(), pf = isAbsolute(rel) ? rel : join(repoDir, rel);
    const scratch = join(tmp, "sparse"); mkdirSync(scratch);
    safeGit(scratch, ["init", "-q"]); mkdirSync(join(scratch, ".git", "info"), { recursive: true });
    copyFileSync(pf, join(scratch, ".git", "info", "exclude"));
    const r = safeGitSpawn(scratch, ["-c", "core.ignorecase=false", "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"], { input: Buffer.from(paths.map((p) => `${p}\0`).join("")) });
    if (r.error || (r.status !== 0 && r.status !== 1)) return new Set();
    const included = new Set(r.stdout.toString("utf8").split("\0").filter(Boolean));
    return new Set(paths.filter((p) => !included.has(p)));
  } catch { return new Set(); }
}

/** FC-GIT-HIDDEN-EDIT: assume-unchanged (lowercase ls-files -v tag) and skip-worktree (S) make diff, status and commit trust the index, so an
 *  edited or deleted flagged file changes what checks run while the diff, receipt and commit never carry it. Git decides content equality:
 *  a copy of the index in a run-owned dir (GIT_INDEX_FILE) has both bits cleared on the flagged paths, is refreshed (the stat cache forgives
 *  a touched file whose bytes match, CRLF conversion included), and `diff-files` names every flagged path that still differs, a deleted one
 *  and a moved submodule included. The hardened config pins core.trustctime and core.checkStat so a repo cannot hide a same-size edit. A
 *  deleted skip-worktree path is spared only when the sparse-checkout patterns exclude it (sparseExcluded). Zero flagged paths cost one ls-files. Any error is a note. */
export function hiddenEdits(repoDir: string): string[] {
  let tmp = "";
  try {
    const idxRel = safeGit(repoDir, ["rev-parse", "--git-path", "index"]).trim(), idx = isAbsolute(idxRel) ? idxRel : join(repoDir, idxRel);
    const flags = new Map<string, string>();
    for (const l of safeGit(repoDir, ["-c", "core.quotePath=false", "ls-files", "-v", "-z"], { maxBuffer: Math.max(64 << 20, statSync(idx).size * 32) }).split("\0")) {
      const m = /^([a-zS]) ([\s\S]+)$/.exec(l);
      if (m) flags.set(m[2]!, m[1]!);
    }
    if (flags.size === 0) return [];
    tmp = mkdtempSync(join(tmpdir(), "loki-hidden-")); const copy = join(tmp, "index"), env = { ...process.env, GIT_INDEX_FILE: copy };
    copyFileSync(idx, copy);
    const paths = Buffer.from([...flags.keys()].map((p) => `${p}\0`).join(""));
    for (const bit of ["--no-assume-unchanged", "--no-skip-worktree"]) safeGit(repoDir, ["update-index", bit, "-z", "--stdin"], { env, input: paths, stdio: ["pipe", "pipe", "ignore"] }); // one bit per call: update-index acts on the first only
    const rf = safeGitSpawn(repoDir, ["update-index", "-q", "--refresh"], { env, encoding: "utf8" }); // exit 1 is "needs update" (a changed or deleted path): the diff below names it
    if (rf.error || (rf.status !== 0 && rf.status !== 1)) throw rf.error ?? new Error("refresh failed");
    const out = safeGit(repoDir, ["-c", "core.quotePath=false", "diff-files", "--name-status", "-z"], { env, maxBuffer: 64 << 20 }).split("\0");
    let sparse: Set<string> | undefined; const hidden: string[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const st = out[i]!, f = out[i + 1]!, tag = flags.get(f);
      if (tag === undefined) continue; // a change to an unflagged path is the ordinary diff's to report
      if (st === "D" && tag === "S") { sparse ??= sparseExcluded(repoDir, tmp, [...flags].filter(([, t]) => t === "S").map(([q]) => q)); if (sparse.has(f)) continue; } // absent by sparse checkout: the pattern file really excludes it
      hidden.push(f);
    }
    return hidden.map((p) => `tracked file edited while assume-unchanged or skip-worktree hides it from diff and commit: ${p}`);
  } catch { return ["assume-unchanged or skip-worktree check could not read the index"]; }
  finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}

/** FC-IGNORE-RULE-HIDES-INPUT: changedFiles lists untracked files with --exclude-standard, so a pattern the run adds to .git/info/exclude or to the
 *  effective core.excludesFile hides a planted conftest.py from the seal, receipt and PR. Intake records, per source, the path git resolves
 *  (core.excludesFile through `git config --type=path`, else the XDG default) and the sha256 of its content, "missing" for no file, "unreadable"
 *  for a file that cannot be read. Verify compares: a changed hash or a new path is a note naming the file, and the ignored files the run created
 *  are listed. Intake also hashes every ignored untracked .gitignore, pyvenv.cfg and virtual-environment interpreter or tool
 *  (exec_files); one added or changed by the run is a note naming it, and the only exemption is a pure tool cache (pureToolCache). A
 *  .gitignore in the changed files is a note naming it. A missing or malformed snapshot, or a failed listing, is a note too (fail closed). */
export type IgnoreSource = { path: string; state: string };
export type IgnoreSnapshot = { at: number; info_exclude: IgnoreSource; global_excludes: IgnoreSource; exec_files: Record<string, string> | null };
/** Ignored, untracked files that decide what verify runs or imports: a .gitignore, a pyvenv.cfg, and the interpreter and tools verify launches
 *  (python*, ruff, pytest) from the bin or Scripts directory of a virtual environment (a pyvenv.cfg directory, .venv or venv). A hidden conftest.py, site hooks and .pth files are
 *  hiddenRunnerConfigs' concern (features/runner_config.ts), which skips what a package install wrote. Path -> content hash, "link:<target>" for a symlink;
 *  null when the listing failed. */
const EXEC_NAMES = new Set([".gitignore", "pyvenv.cfg"]);
const VENV_TOOL = /^(python[0-9.]*(\.exe)?|ruff(\.exe)?|pytest(\.exe)?|py\.test)$/;
function execFiles(repoDir: string): Record<string, string> | null {
  let all: string[];
  try { all = safeGit(repoDir, ["-c", "core.quotePath=false", "ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter((f) => f && !f.startsWith(".loki/")); } catch { return null; }
  const roots = new Set([".venv", "venv", ...all.filter((f) => basename(f) === "pyvenv.cfg").map((f) => dirname(f))]);
  const inVenvBin = (f: string): boolean => { for (let d = dirname(f); d !== "." && d !== "/"; d = dirname(d)) if ((basename(d) === "bin" || basename(d) === "Scripts") && roots.has(dirname(d))) return true; return false; };
  const out: Record<string, string> = {};
  for (const f of all) {
    if (!(EXEC_NAMES.has(basename(f)) || (VENV_TOOL.test(basename(f)) && inVenvBin(f)))) continue;
    const abs = join(repoDir, f);
    try { const st = lstatSync(abs); out[f] = st.isSymbolicLink() ? `link:${readlinkSync(abs)}` : st.size > 4_000_000 ? `big:${st.size}` : createHash("sha256").update(readFileSync(abs)).digest("hex"); } catch { out[f] = "unreadable"; }
  }
  return out;
}
function ignoreSource(path: string): IgnoreSource {
  try { return { path, state: existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing" }; } catch { return { path, state: "unreadable" }; }
}
export function ignoreSnapshot(repoDir: string): IgnoreSnapshot {
  const resolved = (args: string[], dflt: string): string => {
    try { const v = safeGit(repoDir, args).trim(); return v ? resolve(repoDir, v) : dflt; } catch { return dflt; }
  };
  const info = resolved(["rev-parse", "--git-path", "info/exclude"], join(repoDir, ".git", "info", "exclude"));
  const xdg = process.env["XDG_CONFIG_HOME"] || join(process.env["HOME"] ?? "", ".config");
  const glob = resolved(["config", "--type=path", "--get", "core.excludesFile"], join(xdg, "git", "ignore"));
  return { at: Date.now(), info_exclude: ignoreSource(info), global_excludes: ignoreSource(glob), exec_files: execFiles(repoDir) };
}
/** A path for a note: repo-relative inside the repo, `~/...` under the home directory, else the bare file name. Never absolute (notes reach receipt.json and the PR body). */
function noteLabel(repoDir: string, p: string): string {
  const home = process.env["HOME"], inside = (root: string): string | null => { const r = relative(root, p); return r && !r.startsWith("..") && !isAbsolute(r) ? r : null; };
  const rel = inside(repoDir); if (rel) return rel;
  const h = home ? inside(home) : null; if (h) return `~/${h}`;
  return basename(p);
}
/** Exact .gitignore text each tool writes into its own cache directory, captured from a real run of that tool and compared by string equality (no pattern, no bare "*").
 *  A tool is listed only when its text was captured: nox writes no cache directory, and tox's real text is a bare "*", which any planted file could imitate, so neither is exempt. */
const TOOL_CACHE_GITIGNORE: Record<string, string> = {
  ".pytest_cache": "# Created by pytest automatically.\n*\n", // pytest 9.2.0
  ".mypy_cache": "# Automatically created by mypy\n*\n", // mypy 2.4.1
  ".ruff_cache": "# Automatically created by ruff.\n*\n", // ruff 0.17.3
  ".hypothesis": "# This .gitignore file was automatically created by Hypothesis. Hypothesis gitignores\n# .hypothesis by default, because we generally recommend that .hypothesis not be checked\n# into version control.\n#\n# If you *would* like to check .hypothesis into version control, you should delete this\n# file. Hypothesis will not re-create this .gitignore unless .hypothesis is deleted (and\n# if it does, that's a bug - please report it!)\n\n*\n", // hypothesis 6.170.13
};
const CACHE_CODE_EXT = /\.(py[a-z]?|pth|so|pyd|dylib|dll|js|mjs|cjs|ts|sh|rb|pl)$/i;
/** True only when `dir` (repo-relative) is a known pure tool cache: its .gitignore is exactly that tool's own text and nothing under it is importable, executable, linked, or a virtual environment. Any doubt is false. */
function pureToolCache(repoDir: string, dir: string): boolean {
  const text = TOOL_CACHE_GITIGNORE[basename(dir)];
  if (text === undefined) return false;
  try {
    if (readFileSync(join(repoDir, dir, ".gitignore"), "utf8") !== text) return false;
    let seen = 0;
    const walk = (rel: string): boolean => {
      for (const e of readdirSync(join(repoDir, rel), { withFileTypes: true })) {
        if (++seen > 5000 || e.isSymbolicLink()) return false;
        const r = join(rel, e.name);
        if (e.isDirectory()) { if (/^(bin|Scripts|site-packages|lib|lib64|include)$/.test(e.name) || !walk(r)) return false; continue; }
        if (!e.isFile() || CACHE_CODE_EXT.test(e.name) || ((EXEC_NAMES.has(e.name) || /^(conftest|sitecustomize|usercustomize)\./.test(e.name)) && e.name !== ".gitignore") || /^python/i.test(e.name) || (statSync(join(repoDir, r)).mode & 0o111) !== 0) return false;
      }
      return true;
    };
    return walk(dir);
  } catch { return false; }
}
export function ignoreRuleChanges(repoDir: string, snap: unknown, baseSha?: string): string[] {
  const ok = (v: unknown): v is IgnoreSource => !!v && typeof (v as IgnoreSource).path === "string" && typeof (v as IgnoreSource).state === "string";
  const s = snap as Partial<IgnoreSnapshot> | null | undefined;
  if (!s || typeof s.at !== "number" || !ok(s.info_exclude) || !ok(s.global_excludes) || s.info_exclude.state === "unreadable" || s.global_excludes.state === "unreadable") return ["ignore rules could not be compared with the intake snapshot: the file .git/info/exclude or core.excludesFile was not recorded readable"];
  try {
    const now = ignoreSnapshot(repoDir), notes: string[] = [];
    for (const [label, a, b] of [[".git/info/exclude", s.info_exclude, now.info_exclude], ["core.excludesFile", s.global_excludes, now.global_excludes]] as const) {
      if (b.state === "unreadable") notes.push(`ignore rules could not be read at verify: ${label}`);
      else if (a.path !== b.path) notes.push(`ignore rules changed while the run was in progress: ${label} now resolves to ${noteLabel(repoDir, b.path)} (was ${noteLabel(repoDir, a.path)})`);
      else if (a.state !== b.state) notes.push(`ignore rules changed while the run was in progress: ${label} was edited, so git may hide files the run created`);
    }
    // Fail closed: nothing that can hold an interpreter or import-path content is ever exempt. Only a pure tool cache is: the tool's own .gitignore,
    // byte for byte, in a directory with no importable, executable, linked or virtual-environment content.
    const prior = s.exec_files, cur = execFiles(repoDir);
    if (!prior || !cur) return ["ignore rules could not be compared with the intake snapshot: the ignored files that can change what verify runs were not recorded or could not be listed"];
    const gi = new Set(changedFiles(repoDir, baseSha ?? "HEAD").filter((f) => basename(f) === ".gitignore"));
    const hidden: string[] = [];
    for (const [f, h] of Object.entries(cur)) {
      if (prior[f] === h) continue;
      if (basename(f) === ".gitignore" && pureToolCache(repoDir, dirname(f))) continue;
      if (basename(f) === ".gitignore") gi.add(f); else hidden.push(f);
    }
    if (gi.size) notes.push(`ignore rules changed while the run was in progress: ${[...gi].slice(0, 20).join(", ")} was added or edited, so git may hide files the run created`);
    if (hidden.length) notes.push(`an ignored file that can change what verify runs or imports was added or changed during the run: ${hidden.slice(0, 20).join(", ")}${hidden.length > 20 ? ` (+${hidden.length - 20} more)` : ""}`);
    const listIgnored = (): string[] => safeGit(repoDir, ["-c", "core.quotePath=false", "ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter((f) => f && !f.startsWith(".loki/"));
    if (notes.length === 0) return [];
    const made = listIgnored().filter((f) => { try { const st = statSync(join(repoDir, f)); return Math.max(st.birthtimeMs, st.mtimeMs) >= s.at!; } catch { return false; } });
    if (made.length) notes.push(`ignored file created during the run, hidden from the diff and the receipt: ${made.slice(0, 20).join(", ")}${made.length > 20 ? ` (+${made.length - 20} more)` : ""}`);
    return notes;
  } catch { return ["ignore rules could not be compared with the intake snapshot: git failed"]; }
}

/** changedFiles enriched with numstat counts and name-status; untracked files get a line count as additions. Throws on git failure. */
export function diffFiles(repoDir: string, baseSha: string, skip?: (f: string) => boolean): DiffFile[] {
  const paths = changedFiles(repoDir, baseSha, skip), stat = new Map<string, DiffFile>();
  // changedFiles hides .loki/ (runtime state), but a tracked .loki/config.json is a grading input: a change to it must stay visible to the critical rules
  try { if (safeGit(repoDir, ["diff", "--no-renames", "--name-only", baseSha, "--", ".loki/config.json"]).trim() && !paths.includes(".loki/config.json")) paths.push(".loki/config.json"); } catch { /* best effort */ }
  // -z with --no-renames: NUL-terminated simple records, so a name with a quote, backslash, tab or newline is never escaped (FC-CHANGED-PATH-QUOTED)
  for (const l of safeGit(repoDir, ["-c", "core.quotePath=false", "diff", "--no-renames", "--numstat", "-z", baseSha]).split("\0")) {
    const [a, d, ...p] = l.split("\t"), path = p.join("\t");
    if (path) stat.set(path, { path, added: Number(a) || 0, deleted: Number(d) || 0 });
  }
  const ns = safeGit(repoDir, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-status", "-z", baseSha]).split("\0");
  for (let i = 0; i + 1 < ns.length; i += 2) {
    const f = stat.get(ns[i + 1] ?? ""), s = ns[i];
    if (f) f.status = s?.startsWith("A") ? "added" : s?.startsWith("D") ? "deleted" : "modified";
  }
  const out = paths.map((path) => {
    const f = stat.get(path);
    if (f) return f;
    let n = 0; try { n = readFileSync(join(repoDir, path), "utf8").split("\n").length; } catch { /* unreadable or binary */ }
    return { path, added: n, deleted: 0, status: "added" as const };
  });
  const rules = criticalRules(repoDir, baseSha), added = new Map<string, string>();
  try { // FC-CRITICAL-CLASS-GRADED-LOW: the added lines per file feed the diff-semantic rules; a read failure leaves only the path rules
    let cur = "";
    for (const l of safeGit(repoDir, ["-c", "core.quotePath=false", "diff", "--no-renames", "-U0", baseSha]).split("\n")) {
      if (l.startsWith("+++ b/")) cur = l.slice(6); else if (l.startsWith("+++ ")) cur = ""; else if (cur && l.startsWith("+")) added.set(cur, `${added.get(cur) ?? ""}${l.slice(1)}\n`);
    }
  } catch { /* best effort */ }
  for (const f of out) {
    let text = added.get(f.path) ?? "";
    if (!text && f.status === "added") { try { text = readFileSync(join(repoDir, f.path), "utf8"); } catch { /* unreadable or binary */ } }
    const rule = criticalRuleFor(f.path, text, rules); if (rule) f.critical = rule;
  }
  for (const f of out) { // TEN-GATES-18: tag manifests whose dependency set changed (advisory input; a read failure leaves it untagged)
    if (f.status === "deleted" || !MANIFEST_LOCKS.some(([m]) => m.test(f.path))) continue;
    try {
      const oldText = f.status === "added" ? "" : safeGit(repoDir, ["show", `${baseSha}:${f.path}`]);
      const newText = readFileSync(join(repoDir, f.path), "utf8");
      const patch = f.status === "added" ? newText.split("\n").map((l) => `+${l}`).join("\n") : safeGit(repoDir, ["diff", "-U0", baseSha, "--", f.path]);
      if (manifestDepsChanged(f.path, oldText, newText, patch)) f.deps = true;
    } catch { /* best effort */ }
  }
  return out;
}

/** Writes .loki/state/risk-tier.json atomically; best effort, a recording failure never fails the run. */
export function recordRisk(repoDir: string, a: RiskAssessment): string | null {
  try {
    const dir = join(repoDir, ".loki", "state"), p = join(dir, "risk-tier.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(a, null, 2) + "\n"); renameSync(`${p}.tmp`, p);
    return p;
  } catch { return null; }
}

/** TEN-QUALITY-01: the decisive block of a failed check's output for the fix brief. Pure: ANSI stripped, absolute repo paths made
 *  repo-relative, secrets redacted, capped at `cap` bytes. pytest "E " lines + last frame, jest/vitest Expected/Received, node/bun
 *  AssertionError, go "--- FAIL" + next lines, tsc/ruff diagnostics. Unknown shapes fall back to the last few lines. */
export const EXCERPT_GROUP_CAP = 1500;
export const EXCERPT_TOTAL_CAP = 6144;
/** Cut to at most cap UTF-8 bytes without leaving a partial code point (a trailing U+FFFD from the cut is stripped). */
export function truncateBytes(s: string, cap: number): string {
  const buf = Buffer.from(s, "utf8");
  return buf.length <= cap ? s : buf.subarray(0, Math.max(0, cap)).toString("utf8").replace(/\uFFFD$/, "");
}
export function failureExcerpt(out: string, repoDir = "", cap = EXCERPT_GROUP_CAP): string {
  let t = stripAnsi(out.slice(-65536)).replace(/\r/g, "");
  if (repoDir) t = t.split(repoDir.replace(/\/+$/, "") + "/").join("");
  const lines = t.split("\n").map((l) => l.replace(/\s+$/, ""));
  const pick = new Set<number>();
  const take = (i: number, n = 1): void => { for (let k = 0; k < n && i + k < lines.length; k++) if (lines[i + k]!.trim()) pick.add(i + k); };
  lines.forEach((l, i) => {
    if (/^E\s/.test(l)) take(i);
    else if (/^\s*(Expected|Received)\b/.test(l) || /^\s*expect\(.*\)\.\w+/.test(l)) take(i);
    else if (/^[\w./@-]+\.py:\d+: /.test(l)) take(i);
    else if (/AssertionError|^\s*(expected|actual)\b.*[:=]|^\s*(not ok|FAILED)\b/.test(l)) take(i, 3);
    else if (/^\s*--- FAIL/.test(l)) take(i, 4);
    else if (/^[\w./@-]+\.\w+(\(\d+,\d+\)|:\d+(:\d+)?)[:\s].*\b(error|TS\d+|[A-Z]{1,3}\d{3,4})\b/.test(l)) take(i);
  });
  const lastFrame = lines.map((l, i) => (/^[\w./@-]+\.py:\d+: /.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (lastFrame !== undefined && [...pick].some((i) => /^E\s/.test(lines[i]!))) take(lastFrame);
  let body = [...pick].sort((a, b) => a - b).map((i) => lines[i]!).join("\n");
  if (!body) body = lines.filter((l) => l.trim()).slice(-6).join("\n");
  body = redactSecrets(body);
  return truncateBytes(body, cap);
}

// Wall base-run exit classification, moved from engine10/stages/wall.ts (core line budget); this module owns result classification.
// B1/B2/B3/B4 (r3, opus review of E-125): only the short-summary line names the FINAL exception -- immune to a captured stdout/stderr block forging an earlier frame (B3), or an earlier link in a chain (B4).
export function pytestCollectionIsRed(output: string, repoDir: string): boolean {
  if (/ModuleNotFoundError/.test(output)) return moduleToBeCreated(output, repoDir); // a missing module is red only when it is neither in the repo nor a declared dependency: the Wall file imports what the task creates, and after implement it must still import and pass
  const real = (p: string): string | null => { try { return realpathSync(isAbsolute(p) ? p : join(repoDir, p)); } catch { return null; } };
  const repoReal = real(repoDir); const under = (p: string): boolean => { const r = real(p); return !!repoReal && !!r && (r === repoReal || r.startsWith(`${repoReal}/`)); };
  // pytest reports an ImportError from `from x import y` via its own (short-summary-less) path; the message always carries the module's own (absolute) file, so a direct scan is unambiguous.
  const imp = /ImportError: cannot import name .* from ['"][\w.]+['"] \(([^)]+)\)/.exec(output); if (imp) return under(imp[1]!);
  // B3 (r4): captured stdout prints ABOVE the short summary, so trust only the LAST ERROR line after the final summary header, and E lines only from the first collecting block, cut at its first Captured separator. No header: fail closed.
  const hdr = [...output.matchAll(/^=+ short test summary info =+$/gm)].pop(); if (!hdr) return false;
  const cls = [...output.slice(hdr.index).matchAll(/^ERROR \S+ - (\w+Error): /gm)].pop()?.[1]; if (cls !== "AttributeError" && cls !== "NameError") return false;
  const start = output.search(/^_+ ERROR collecting /m); if (start < 0 || start > hdr.index) return false; const block = output.slice(start, hdr.index).split(/^-+ Captured .*$/m)[0]!;
  const eLines = [...block.matchAll(new RegExp(`^E {3}${cls}: (.*)$`, "gm"))]; const eLine = eLines[eLines.length - 1]; if (!eLine) return false;
  // B1 (r3): an AttributeError's frame is only where the dotted access sits, not who owns the missing attribute -- go by the message instead.
  if (cls === "AttributeError") { const m = /^module ['"]([\w.]+)['"] has no attribute/.exec(eLine[1]!); return !!m && moduleUnderRepo(repoDir, m[1]!); }
  // NameError: the raise site must be repo code, not merely an import line naming an outside module. B2 (r3): a frame path may contain a space.
  const frames = [...block.slice(0, eLine.index).matchAll(/^(.+?):\d+: in \S+\n\s*(.*)$/gm)]; const last = frames[frames.length - 1];
  return !!last && under(last[1]!) && !/^\s*(import\s|from\s\S+\s+import\b)/.test(last[2] ?? "");
}
const PY_SKIP_DIR = /^(\.|(node_modules|venv|__pycache__|dist|build|site-packages)$)/;
/** Python sources under repoDir (at most 5000); dot, vendored and build directories are never entered. Throws when repoDir itself is unreadable. */
function walkPython(repoDir: string): string[] {
  const py: string[] = [], stack = [""];
  while (stack.length && py.length < 5000) {
    const dir = stack.pop()!; let ents;
    try { ents = readdirSync(join(repoDir, dir), { withFileTypes: true }); } catch (e) { if (!dir) throw e; continue; }
    for (const e of ents) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!PY_SKIP_DIR.test(e.name)) stack.push(rel); continue; }
      if (e.name.endsWith(".py")) py.push(rel);
    }
  }
  return py;
}
/** Does the source import `name`: `import a.b`, `from a.b import x`, or for a dotted name `from a import b`. Importing a deeper module also names its parents (`import a.b.c` imports `a` and `a.b`), but importing only the parent does not name a submodule. */
function importsName(t: string, name: string): boolean {
  const q = (s: string): string => s.replace(/\./g, "\\."), dot = name.lastIndexOf(".");
  if (new RegExp(`^[ \\t]*import[ \\t]+(?:[\\w.]+(?:[ \\t]+as[ \\t]+\\w+)?[ \\t]*,[ \\t]*)*${q(name)}(?!\\w)`, "m").test(t) || new RegExp(`^[ \\t]*from[ \\t]+${q(name)}(?!\\w)`, "m").test(t)) return true;
  if (dot < 0) return false;
  const last = new RegExp(`(?<![\\w.])${name.slice(dot + 1)}(?!\\w)`);
  return [...t.matchAll(new RegExp(`^[ \\t]*from[ \\t]+${q(name.slice(0, dot))}[ \\t]+import[ \\t]+(\\([^)]*\\)|[^\\n]*)`, "gm"))].some((m) => last.test(m[1]!));
}
/** The missing module a collection error names. pytest: the first E line of the final run of E lines in the first "ERROR collecting" block, cut at its first Captured separator. Otherwise (unittest): the last line before the Ran footer. Text the test itself printed is never read. */
function missingModule(output: string): string | undefined {
  const re = /^(?:E {3})?ModuleNotFoundError: No module named '([\w.]+)'\s*$/, start = output.search(/^_+ ERROR collecting /m);
  if (start >= 0) {
    // The matched line must open the final run of E lines (the exception-type line): pytest prefixes every line of a multi-line message with E, so a raised message could otherwise carry a forged last line.
    const ls = output.slice(start).split(/^-+ Captured .*$/m)[0]!.split(/^=+ /m)[0]!.split("\n"), isE = (l: string | undefined): boolean => l !== undefined && /^E(?: {3}.*)?$/.test(l);
    let i = ls.length - 1; while (i >= 0 && !isE(ls[i])) i--;
    while (i > 0 && isE(ls[i - 1])) i--;
    return i < 0 ? undefined : re.exec(ls[i]!)?.[1];
  }
  return re.exec(output.split(/^(?:-+\n)?Ran \d+ tests? in /m)[0]!.trimEnd().split("\n").pop() ?? "")?.[1];
}
/** Red on base only for a module that is not in the repo, not declared in a dependency manifest, and not imported by any non-Wall Python file (tests included): that name is what the task creates. A dotted name is matched whole, so importing its package does not hide a new submodule. */
function moduleToBeCreated(output: string, repoDir: string): boolean {
  const name = missingModule(output); if (!name || moduleUnderRepo(repoDir, name)) return false;
  let py; try { py = walkPython(repoDir); } catch { return false; }
  if (declaresPythonDep(repoDir, name.split(".")[0]!)) return false;
  const rel = name.replace(/\./g, "/");
  return !py.some((f) => {
    if (`/${f}`.endsWith(`/${rel}.py`) || `/${f}`.endsWith(`/${rel}/__init__.py`)) return true;
    if (/(^|\/)loki_wall_/.test(f)) return false;
    try { return importsName(readFileSync(join(repoDir, f), "utf8"), name); } catch { return false; }
  });
}
function moduleUnderRepo(repoDir: string, name: string): boolean { const rel = name.replace(/\./g, "/"); return existsSync(join(repoDir, `${rel}.py`)) || existsSync(join(repoDir, rel, "__init__.py")); }
// E-125 r5: exit-1 output is red only from the real final summary, never captured text. The runner appends -rfE, so a repo's `-q` addopts (stacked to -qq, no footer) still lists FAILED lines.
function pytestExit1IsRed(output: string): boolean {
  if (/^!+ _pytest\.outcomes\.Exit\b/m.test(output)) return false; // pytest.exit(...) can print any text, incl. "1 failed"
  if (/^=*\s*(\d+ \w+(, )?)*\d+ failed\b.* in [\d.]+s/.test(output.trimEnd().split("\n").pop() ?? "")) return true;
  const hdr = [...output.matchAll(/^=+ short test summary info =+$/gm)].pop();
  return !!hdr && /^FAILED \S+/m.test(output.slice(hdr.index));
}
// B2 (r2): jest/vitest/bun red requires a parsed failed-test count above 0; unparseable output stays 0 (not_run).
function parsedFailCount(runner: RunnerName, output: string): number {
  const m = runner === "bun" ? /^\s*(\d+)\s+fail\s*$/m.exec(output)
    : runner === "jest" ? /Tests:\s*(\d+)\s+failed/i.exec(output)
    : runner === "vitest" ? /Tests\s+(\d+)\s+failed/i.exec(output) : null;
  return m ? Number(m[1]) : 0;
}
// A-103 node:test red, mirroring pytest: a missing module inside the repo or an error thrown by code under test is red; a missing bare package, or an error thrown from the Wall file itself (Jest globals), is not. A missing-module crash is not_run only when the file itself failed (no named subtest failed, spec or TAP), and any failing subtest whose error is not a Wall-file Reference/SyntaxError makes the file red, so a child process crash or printed footer cannot hide a real red. Only node's own lines count (col-0 crash text, or a failing-tests block's error line and first frame), never an assertion diff.
function nodeIsRed(f: TestRef, raw: string): boolean {
  // node 20/22 off a TTY print TAP: crash text is "# "-prefixed and a failure is a yaml block (name: 'X', stack: |-). Strip the prefix from non-counter lines so the spec-shape regexes apply.
  const o = raw.replace(/^# (?!(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|Subtest)\b)/gm, "");
  const mod = /^Error(?: \[\w+\])?: Cannot find (?:module|package) '([^']+)'(?:(?!\u2716)[\s\S])*?\nNode\.js v/m.exec(o), top = /^(\S+):\d+\n.*\n.*\n\n?(?:ReferenceError|SyntaxError)\b/m.exec(o);
  const named = [...o.matchAll(/^(?:\u2716|\s*not ok \d+ -) (?!failing tests:)(.+?)(?: \(|$)/gm)].some((m) => !f.path.endsWith(m[1]!) && !m[1]!.endsWith(f.path)), blk = o.split("failing tests:")[1] ?? "", esm = /^SyntaxError: The requested module '([^']+)' does not provide an export named/m.exec(o), errs = [...blk.matchAll(/^ {2}(\w+Error): .*\n\s+at (?:.*\()?([^\s()]+?):\d+:\d+/gm), ...o.matchAll(/^ +name: '(\w+Error)'\n(?:.*\n)*? +stack: \|-\n\s+(?:.*\()?([^\s()]+?):\d+:\d+/gm)];
  return /^(?:#|\u2139) fail [1-9]/m.test(raw) && (/^ {2}AssertionError\b/m.test(blk) || /^ +name: 'AssertionError'/m.test(o) || (mod && !named ? /^[./]/.test(mod[1]!) : esm ? /^[./]/.test(esm[1]!) : top ? !top[1]!.endsWith(f.path) : !errs.length || errs.some((e) => !/^(?:Reference|Syntax)Error$/.test(e[1]!) || !(e[2]!.startsWith("node:") || e[2]!.endsWith(f.path))))); // ESM "cannot import name": red for a repo path, not_run for a bare package
}
// D42 (3) exit classification. B4 (r2): any "system"-interpreter result is not_run, same as verify (E-98a).
// Red: pytest exit 1/resolved 2; jest/vitest/bun a parsed failed count>0; go/cargo a readable failing test id. npm (B2, coarse): never fail.
/** FC-69: why a base run was not_run, for the receipt and console ("Wall test not executed: <file>: <reason>"). */
export function notRunReason(status: number | null, interpreter?: "project" | "system"): string {
  if (interpreter === "system") return "ran under the system interpreter, not the project's, so the result proves nothing";
  if (status === null) return "the test runner did not start or timed out";
  if (status === 126 || status === 127) return `the test runner command was not found or not executable (exit ${status})`;
  return status === 0 ? "exit 0 but no executed test count could be confirmed" : `exit ${status} but the runner output showed no readable failing test`;
}
/** A Wall file for a feature that does not exist on base cannot build there. That is red on base only for output the BUILD TOOL itself printed with no test started: go -json build-fail/[build failed] events with no test event, cargo "could not compile" with no libtest header, javac/maven/gradle compile errors with no test summary. This is base-side evidence only: the head run must still build and pass (verify, Seal wall.passed) or the file never counts; a Wall that also fails to build on head is FAILED there. */
function buildFailedBeforeAnyTest(runner: RunnerName, raw: string): boolean {
  const out = stripAnsi(raw);
  switch (runner) {
    case "go": {
      let build = false;
      for (const x of out.split("\n")) {
        if (!x.trim() || /^go: /.test(x)) continue;
        let e: { Action?: unknown; Package?: unknown; Test?: unknown; ImportPath?: unknown; Output?: unknown };
        try { e = JSON.parse(x) as typeof e; } catch { return false; }
        if (!e || typeof e !== "object" || typeof e.Action !== "string") return false;
        if (typeof e.Test === "string" && e.Test) return false; // a test started: this is a test result, not a build failure
        if (e.Action === "build-fail" && typeof e.ImportPath === "string" && e.Package === undefined) build = true;
        if (e.Action === "output" && typeof e.Package === "string" && /^FAIL\t\S+ \[(?:build|setup) failed\]\n?$/.test(String(e.Output ?? ""))) build = true;
        if (e.Action === "pass" || e.Action === "run") return false;
      }
      return build;
    }
    case "cargo": return /^error: could not compile `[^`]+`/m.test(out) && !/^running \d+ tests?\b/m.test(out) && !/^test result: /m.test(out);
    case "javac": return /^\S+\.java:\d+: error: /m.test(out) && !/^LOKI_JAVA_TESTS: /m.test(out);
    case "maven": return /COMPILATION ERROR|Compilation failure/.test(out) && !/Tests run:/.test(out);
    case "gradle": return /Execution failed for task ':[\w:-]*compile\w*Java'/.test(out) && !/\d+ tests? completed/.test(out);
    default: return false;
  }
}
export function classify(f: TestRef, status: number | null, output: string, repoDir: string, interpreter?: "project" | "system"): "pass" | "fail" | "not_run" {
  if (interpreter === "system") return "not_run";
  output = stripAnsi(output); // FC-69: every parser below reads plain text, whoever captured it
  if (status === null || status === 126 || status === 127) return "not_run"; if (status === 0) return f.runner !== "go" && classifyCheck({ kind: "test", ok: true, out: output, path: f.path }).result === "pass" ? "pass" : "not_run"; // go: a base pass is never uncorroborated here (corroboratePass runs where verify counts it) // FC-16: exit 0 with zero or unknown executed tests is not a pass
  if (f.runner === "unittest") return status === 1 && unittestCount(output, false) !== null ? (/unittest\.loader\._FailedTest|Failed to import test module/.test(output) ? (pytestCollectionIsRed(output, repoDir) ? "fail" : "not_run") : "fail") : "not_run"; // red only on a trusted FAILED trailer; a module that failed to import is red only when the missing name is the repo's own (pytestCollectionIsRed), else not_run, as for pytest
  if (f.runner === "pytest") return status === 1 ? (pytestExit1IsRed(output) ? "fail" : "not_run") : status === 2 ? (pytestCollectionIsRed(output, repoDir) ? "fail" : "not_run") : "not_run";
  if (f.runner === "jest" || f.runner === "vitest" || f.runner === "bun") return parsedFailCount(f.runner, output) > 0 ? "fail" : "not_run";
  if (f.runner === "maven" || f.runner === "gradle" || f.runner === "javac") { const j = javaSummary(output); return (j && j.failed > 0) || buildFailedBeforeAnyTest(f.runner, output) ? "fail" : "not_run"; } // HV1-03b: red only on a vouched summary that counts failures; a missing tool, no report or an unvouched report is not_run (verify's own exit-code path treats a compile error as fail, the safe direction)
  if (f.runner === "go" || f.runner === "cargo") return readableFailIds(f.runner, output).length > 0 || buildFailedBeforeAnyTest(f.runner, output) ? "fail" : "not_run"; // red on a readable failing test id, or on a toolchain build failure before any test started (the feature the Wall names is absent on base); a panic outside a test or unparsed output stays not_run
  return f.runner === "node" && nodeIsRed(f, output) ? "fail" : "not_run"; // npm: coarse (B2), never a per-file red
}

/** TEN-SPEED-19: LOKI_E10_BASE_JOBS, default 1 (sequential); an invalid value or one below 1 falls back to 1, capped at 16. */
export function baseJobs(): number { const n = Number(process.env.LOKI_E10_BASE_JOBS); return Number.isInteger(n) && n >= 1 ? Math.min(n, 16) : 1; }
/** TEN-SPEED-18: LOKI_E10_VERIFY_JOBS, an integer 1..8; unset, invalid or below 1 means 1. */
export const verifyJobs = (): number => { const n = Number.parseInt(process.env["LOKI_E10_VERIFY_JOBS"] ?? "", 10); return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1; };
/** TEN-SPEED-19: map items through an async fn with at most `jobs` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], jobs: number, fn: (item: T) => Promise<R>, stop: () => boolean = () => false): Promise<R[]> { // stop() true: no new item starts; their slots stay empty
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, jobs), items.length) }, async () => { while (next < items.length && !stop()) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}
// A SIGKILL of the owner (a worker group kill on cancel or cap) cannot run its cleanup, so a detached runner group would outlive it. This watcher
// runs in its own group, polls the owner and SIGKILLs the runner group once the owner is gone; the owner kills the watcher at a normal finish.
const WATCHDOG = `const O = __O__, G = __G__; setInterval(() => { try { process.kill(O, 0); } catch { try { process.kill(-G, "SIGKILL"); } catch {} process.exit(0); } }, 200);`;
const watchdogArgv = (): string[] => [process.execPath, ...SAFE_BUN_FLAGS, "-e", WATCHDOG];
function startWatchdog(pgid: number | undefined): ChildProcess | undefined {
  if (!pgid) return undefined;
  const [bin, ...a] = watchdogArgv(); a[a.length - 1] = WATCHDOG.replace("__O__", String(process.pid)).replace("__G__", String(pgid));
  try { const w = spawn(bin!, a, { detached: true, stdio: "ignore", env: { PATH: process.env["PATH"] ?? "" } }); w.on("error", () => {}); w.unref(); return w; } catch { return undefined; }
}
// Bun's spawnSync ignores `detached`, so the sync path cannot lead its own process group. It runs the command through this launcher (a child of the same runtime) which does lead one, kills the whole group at the timeout and prints {status, output}. The test env travels on stdin and the launcher itself gets only PATH, so the command never inherits the parent env.
const GROUP_LAUNCHER = `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const [cmd, args, cwd, ms, wd, env] = JSON.parse(fs.readFileSync(0, "utf8")); const MAX = 1048576; let out = "", err = "", to = false, fin = false;
const c = spawn(cmd, args, { cwd: cwd || undefined, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let w; try { const a = wd.slice(1); a[a.length - 1] = a[a.length - 1].replace("__O__", String(process.pid)).replace("__G__", String(c.pid)); w = spawn(wd[0], a, { detached: true, stdio: "ignore", env: { PATH: process.env.PATH || "" } }); w.on("error", () => {}); } catch {}
const kill = (s) => { try { process.kill(-c.pid, s); } catch { try { c.kill(s); } catch {} } };
const done = (code, sig) => { if (fin) return; fin = true; kill("SIGKILL"); try { w.kill("SIGKILL"); } catch {} const b = Buffer.from(JSON.stringify({ status: to || sig ? null : code, output: out + "\\n" + err })); for (let i = 0; i < b.length;) { try { i += fs.writeSync(1, b, i); } catch (e) { if (e.code !== "EAGAIN") break; } } process.exit(0); };
setTimeout(() => { to = true; kill("SIGTERM"); setTimeout(() => done(null, 1), 1000); }, ms);
const over = () => { if (out.length > MAX || err.length > MAX) { to = true; kill("SIGKILL"); } };
c.stdout.on("data", (d) => { out += d; over(); }); c.stderr.on("data", (d) => { err += d; over(); });
c.on("error", () => done(null, 1)); c.on("close", done); c.on("exit", (a, b) => setTimeout(() => done(a, b), 500)); `;
/** Sync twin of spawnCollect with the same group-kill and timeout contract (status null on spawn error, signal or timeout). */
export function spawnGroupSync(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [...SAFE_BUN_FLAGS, "-e", GROUP_LAUNCHER], { input: JSON.stringify([cmd, args, o.cwd ?? "", o.timeoutMs, watchdogArgv(), o.env ?? plainTestEnv()]), env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8", timeout: o.timeoutMs + 5000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  try { return JSON.parse(r.stdout) as { status: number | null; output: string }; } catch { return { status: null, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }; }
}
/** TEN-SPEED-19: async twin of the sync spawn used by RealBaseTestRunner: status is null on spawn error, signal or timeout; output is stdout and stderr merged by arrival. The child leads its own process group: SIGTERM at the timeout, then SIGKILL to the group 1s later, and the result resolves on exit plus a short drain grace, never waiting on a grandchild that holds the pipes. */
export function spawnCollect(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    let out = "", err = "", error = false, done = false; const MAX = 1024 * 1024; // spawnSync parity: stdin EOF, default maxBuffer, "stdout\nstderr" join
    const timers: NodeJS.Timeout[] = [];
    const fin = (status: number | null) => { if (!done) { done = true; timers.forEach(clearTimeout); o.signal?.removeEventListener("abort", abort); killGroup(c.pid, "SIGKILL"); wd?.kill("SIGKILL"); resolve({ status: error ? null : status, output: `${out}\n${err}` }); } };
    const c = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const wd = startWatchdog(c.pid);
    const term = () => { try { process.kill(-c.pid!, "SIGTERM"); } catch { c.kill("SIGTERM"); } };
    timers.push(setTimeout(() => { error = true; term(); timers.push(setTimeout(() => { killGroup(c.pid, "SIGKILL"); fin(null); }, 1000)); }, o.timeoutMs)); // spawn's own timeout would signal the direct child only
    const abort = () => { error = true; term(); timers.push(setTimeout(() => { killGroup(c.pid, "SIGKILL"); fin(null); }, 1000)); }; // an aborted stage ends the whole group like the timeout does, never only the direct child
    if (o.signal?.aborted) abort(); else o.signal?.addEventListener("abort", abort, { once: true });
    const over = () => { if (out.length > MAX || err.length > MAX) { error = true; killGroup(c.pid, "SIGKILL"); } };
    c.stdout?.on("data", (d) => { out += d; over(); }); c.stderr?.on("data", (d) => { err += d; over(); });
    c.on("error", () => { error = true; fin(null); }); c.on("close", (code, sig) => fin(sig ? null : code));
    c.on("exit", (code, sig) => { timers.push(setTimeout(() => fin(sig ? null : code), 500)); }); // drain grace; close normally wins
  });
}
// E-98a B2: .venv, then venv, then an in-repo (realpath under repoDir) VIRTUAL_ENV are "project";
// else <fallback> on PATH, or <lastResort> literal, is "system" -- never proven against repo sources.
type Interpreter = "project" | "system";
export function resolveTool(repoDir: string, bin: string, fallback: string, lastResort = fallback): [string, Interpreter, string[]] {
  const inRepo = (p: string): boolean => { try { const r = relative(realpathSync(repoDir), realpathSync(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); } catch { return false; } };
  const venvEnv = process.env["VIRTUAL_ENV"], onPath = (b: string): string | null => Bun.which(b, { PATH: process.env["PATH"] ?? "" }); // Bun.which caches the startup PATH unless given the live one
  const project = [join(repoDir, ".venv", "bin", bin), join(repoDir, "venv", "bin", bin), ...(venvEnv && inRepo(venvEnv) ? [join(venvEnv, "bin", bin)] : [])].find(existsSync);
  return project ? [project, "project", []] : existsSync(join(repoDir, "uv.lock")) && onPath("uv") ? ["uv", "project", ["run", "--", bin]] : [onPath(fallback) ? fallback : lastResort, "system", []]; // TEN-QUALITY-11: uv.lock, no venv: uv run is the project interpreter
}
/** FC-WALL-GO-FILE-RUNS-WHOLE-PACKAGE: the Test, Fuzz and Example function names of one Go file, matched by name only. Over-inclusion is harmless for -run (a name that is no test matches nothing); a signature check would drop valid tests (multi-line, unnamed or aliased *testing.T, non-ASCII names) and turn a red Wall into no run. TestMain is excluded; [] when unreadable or none. */
export function goTestNames(file: string): string[] {
  try { return [...new Set([...readFileSync(file, "utf8").matchAll(/^func\s+((?:Test|Fuzz|Example)[\p{L}\p{N}_]*)\s*\(/gmu)].map((m) => m[1]!).filter((n) => n !== "TestMain"))]; } catch { return []; }
}
// Command shapes exactly as ENGINE.md section 8's table names them per runner (npm/cargo are
// "coarse": no per-file selection; go runs per package dir, also coarse below that grain).
export function runnerCmd(t: TestRef, repoDir: string): [string, string[], Interpreter?] {
  switch (t.runner) {
    case "pytest": {
      const [cmd, interpreter, pre] = resolveTool(repoDir, "python", "python3", "python");
      return [cmd, [...pre, "-m", "pytest", "-q", t.path], interpreter];
    }
    case "unittest": { // stdlib: a file path is converted to a module name by unittest itself
      const [cmd, interpreter, pre] = resolveTool(repoDir, "python", "python3", "python");
      return interpreter === "project" ? [cmd, [...pre, "-m", "unittest", t.path], interpreter] : [cmd, [...pre, "-m", "unittest", t.path]]; // the stdlib runner needs no project interpreter, so a system python3 is not "not_run"
    }
    case "vitest": return ["npx", ["--no-install", "vitest", "run", t.path]];
    case "jest": return ["npx", ["--no-install", "jest", t.path]];
    case "bun": return ["bun", ["test", t.path]];
    case "node": return ["node", ["--test", `./${t.path}`]];
    case "npm": return ["npm", ["test", "--silent"]];
    case "go": { const names = goTestNames(join(repoDir, t.path)); return ["go", ["test", "-json", ...(names.length ? ["-run", `^(${names.join("|")})$`] : []), `./${dirname(t.path)}`]]; } // one file: only its own Test functions
    case "maven": { const j = javaTestClass(t.path); return [wrapperOr(repoDir, "mvnw", "mvn"), ["-B", "test", `-Dtest=${j.cls.split(".").pop()}`, "-Dsurefire.failIfNoSpecifiedTests=false", "-DfailIfNoTests=false"]]; }
    case "gradle": { const j = javaTestClass(t.path); return [wrapperOr(repoDir, "gradlew", "gradle"), ["cleanTest", "test", "--tests", j.cls, "-i", "--console=plain"]]; } // cleanTest: an up-to-date test task would run nothing
    case "javac": { const j = javaTestClass(t.path); return ["bash", ["-c", JAVAC_WRAPPER, "loki-javac", j.root, j.cls, j.rel]]; }
    case "cargo": return CARGO_TEST_FILE_RE.test(t.path) ? ["cargo", ["test", "--test", basename(t.path, ".rs")]] : ["cargo", ["test"]]; // a Wall-sealed tests/<name>.rs runs by itself
  }
}
/** The legacy per-runner full suite (no multi-root model), one check per detected runner: run by deep.ts, baselined via package_suite.ts fullSuiteSpecs. */
const FULL_SUITE_STATIC: Record<Exclude<RunnerName, "pytest" | "unittest">, { cmd: string; args: string[] }> = {
  vitest: { cmd: "npx", args: ["vitest", "run"] },
  jest: { cmd: "npx", args: ["jest"] },
  bun: { cmd: "bun", args: ["test"] },
  node: { cmd: "node", args: ["--test"] },
  npm: { cmd: "npm", args: ["test", "--silent"] },
  go: { cmd: "go", args: ["test", "-json", "./..."] },
  cargo: { cmd: "cargo", args: ["test"] },
  maven: { cmd: "mvn", args: ["-B", "test"] },
  gradle: { cmd: "gradle", args: ["cleanTest", "test", "-i", "--console=plain"] },
  javac: { cmd: "bash", args: ["-c", JAVAC_WRAPPER, "loki-javac", ".", "-"] },
};
/** FC-FULL-SUITE-IGNORES-PROJECT-INTERPRETER: the one full-suite command per runner. pytest resolves its interpreter exactly as a per-test run does (resolveTool: project .venv, else python3), never a bare `python` that python3-only hosts lack. */
export function fullSuiteCmd(runner: RunnerName, repoDir: string): { cmd: string; args: string[]; interpreter?: Interpreter } {
  if (runner === "maven" || runner === "gradle") { const s = FULL_SUITE_STATIC[runner]; return { ...s, cmd: wrapperOr(repoDir, runner === "maven" ? "mvnw" : "gradlew", s.cmd) }; }
  if (runner !== "pytest" && runner !== "unittest") return FULL_SUITE_STATIC[runner];
  const [cmd, interpreter, pre] = resolveTool(repoDir, "python", "python3", "python");
  return { cmd, args: [...pre, ...(runner === "unittest" ? UNITTEST_DISCOVER_ARGS : ["-m", "pytest", "-q"])], ...(runner === "unittest" && interpreter === "system" ? {} : { interpreter }) };
}
/** FC-01: the one resolver for a test invocation: a package-owned file runs in its package dir with a package-relative path, else exactly runnerCmd at the root. */
export function commandFor(t: TestRef, repoDir: string, api?: ProjectApi | null): { cwd: string; cmd: string; args: string[]; argv: string[]; interpreter?: Interpreter; pkgRoot: string } {
  const site = siteFor(api, repoDir, t.path);
  const base = site?.cwd ?? repoDir, rel = site?.file ?? t.path, mod = t.runner === "go" ? goModDir(base, rel) : base; // go resolves the module from the cwd: a go.mod below the base needs the run to start there
  const [cmd, args, interpreter] = runnerCmd(mod === base ? (site ? { runner: t.runner, path: site.file } : t) : { runner: t.runner, path: relative(mod, join(base, rel)) }, mod === base ? repoDir : mod);
  return { cwd: mod === base ? base : mod, cmd, args, argv: [cmd, ...args], ...(interpreter ? { interpreter } : {}), pkgRoot: mod === base ? site?.root ?? "." : relative(repoDir, mod) || "." };
}
/** The directory of the nearest go.mod at or above the test file, never above `base`; `base` itself when none is found below it (a root go.mod keeps the legacy run from the root). */
function goModDir(base: string, rel: string): string {
  let d = dirname(join(base, rel));
  while (d !== base && relative(base, d) !== "" && !relative(base, d).startsWith("..")) { if (existsSync(join(d, "go.mod"))) return d; d = dirname(d); }
  return base;
}
export function firstError(out: string): string { // the line naming the failing test, minus what varies between identical failures (A-113 stall signature)
  const goOut = (l: string): string => { try { const e = JSON.parse(l) as { Action?: string; Output?: string }; return typeof e.Action === "string" ? (e.Action === "output" || e.Action === "build-output" ? (e.Output ?? "") : "") : l; } catch { return l; } }; // Go json event stream: the failing line is inside the event's Output
  const lines = out.slice(-65536).split("\n").map((l) => (l.startsWith("{") ? goOut(l) : l).trim()).filter(Boolean), l =lines.find((x) => /^(FAILED\s|\u25cf\s.*\u203a|not ok\s|_{3,}\s.+\s_{3,}$)/.test(x)) ?? lines.find((x) => /^[\w./-]+\.go:\d+:\d+: \S/.test(x)) /* go compiler line, before "FAIL pkg [build failed]" */ ?? lines.find((x) => /fail|error/i.test(x) && !/^(=|\u2713|ok\b|PASS)/.test(x)) ?? "";
  return l.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "").replace(/(^|\s)\/(?:[\w.@-]+\/)*[\w.@-]+/g, "$1<path>").replace(/:\d+(?::\d+)?/g, "").replace(/\[?\d+(?:\.\d+)?m?s\]?/g, "").replace(/\s+/g, " ").slice(0, 160);
}

/** FC-PR-BODY-PUBLIC-HYGIENE: the one wording for a check that also fails on the base tree (verify's pre_red_checks). */
export const ALREADY_FAILING_ON_BASE = "already failing on base, not caused by this change";
/** "fail" stays "fail" unless the check is base-red, then it carries the one shared label; every other result is unchanged. */
/** FC-REPO-SKIPPED-TEST-DOWNGRADES: the one wording for an unchanged test the repo itself skips (zero tests on base and head); the check stays not_run in the receipt, never counted against the verdict. */
export const SKIPPED_BY_REPO = "skipped by the repo on base and head";
export const checkResultLabel = (result: string, preRed: boolean, repoSkipped = false): string => (result === "fail" && preRed ? `fail (${ALREADY_FAILING_ON_BASE})` : result === "not_run" && repoSkipped ? `not_run (${SKIPPED_BY_REPO})` : result);

type G = (args: string[]) => Promise<{ out: string; code: number }>;
/** FC-VERIFIED-PR-WITHOUT-ITS-TEST: HEAD is this run's Wall child only when its trailer line names this run, it touches exactly paths of this run's wall.files, and each blob hashes to the sealed sha256. A forged trailer is not enough. */
export async function wallChild(git: G, runId: string, repoDir: string, wallFiles: unknown): Promise<boolean> {
  if (!(await git(["log", "-1", "--format=%B", "HEAD"])).out.split("\n").includes(`Loki-Wall-Publish: ${runId}`)) return false;
  const want = new Map((Array.isArray(wallFiles) ? (wallFiles as { path: string; sha256: string }[]) : []).map((w) => [relative(repoDir, w.path), w.sha256] as const));
  const names = (await git(["diff", "--name-only", "--no-renames", "-z", "HEAD^", "HEAD"])).out.split("\0").filter(Boolean);
  if (names.length === 0) return false;
  for (const n of names) { const h = want.get(n); if (h === undefined || createHash("sha256").update((await git(["cat-file", "blob", `HEAD:${n}`])).out).digest("hex") !== h) return false; }
  return true;
}

/** FC-VERIFIED-PR-WITHOUT-ITS-TEST: one child commit of the SEALED Wall bytes on top of the product head, run with NO hooks and NO signing (git() default), so nothing but the named paths can enter it.
 *  Every committed blob must equal the sealed bytes and the commit must touch exactly the published paths; otherwise the child is rolled back (update-ref + read-tree, index and HEAD only) and nothing is published. A re-seal (done) commits nothing. */
const blobSha = (b: Buffer, hex: number): string => createHash(hex === 64 ? "sha256" : "sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
export async function publishWall(git: G, runId: string, repoDir: string, files: { rel: string; bytes: Buffer }[], done: boolean): Promise<boolean> {
  const rels = files.map((f) => f.rel), pre = (await git(["rev-parse", "HEAD"])).out.trim();
  const sound = async (): Promise<boolean> => {
    const names = (await git(["diff", "--name-only", "--no-renames", "-z", "HEAD^", "HEAD"])).out.split("\0").filter(Boolean).sort();
    if (names.join("\0") !== [...rels].sort().join("\0")) return false;
    for (const f of files) { const got = (await git(["rev-parse", `HEAD:${f.rel}`])).out.trim(); if (got === "" || got !== blobSha(f.bytes, got.length)) return false; } // the SEALED bytes, never the worktree file
    return true;
  };
  if (done) return sound();
  for (const f of files) { const abs = join(repoDir, f.rel); try { if (!realpathSync(dirname(abs)).startsWith(realpathSync(repoDir))) return false; } catch { /* dir not created yet */ } rmSync(abs, { force: true }); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, f.bytes); } // rmSync first: an agent-planted symlink is replaced, never written through
  if ((await git(["--literal-pathspecs", "add", "--", ...rels])).code !== 0 || (await git(["--literal-pathspecs", "commit", "-q", "-m", "test: loki acceptance checks (Wall)", "-m", `Loki-Wall-Publish: ${runId}\nLoki-Run: ${runId}`, "--", ...rels])).code !== 0) return false;
  if (await sound()) return true;
  await git(["update-ref", "HEAD", pre]); await git(["read-tree", "HEAD"]); // drop the bad child; the product head and index are as sealed
  return false;
}


/** The council file:line anchor grammar (src/a.ts:42, a.ts:L42, a.ts#L42, a.ts (line 42)); one owner, shared by the council finding schema and the failing-check anchor. */
export const URL_RE = /\b[a-z][a-z0-9+.-]{0,63}:\/\/\S+/gi; // bounded scheme: linear (TEN-SECURITY-26)
export const ANCHOR_RE = /(?<![\w./@-])([\w./@-]{1,512})[`'"]?(?::L?|#L|\s*\(line\s+)([1-9]\d*)(?!\d)/g;
export const EXTENSIONLESS = /^(?:.*\/)?(?:Makefile|GNUmakefile|Dockerfile|Jenkinsfile|Rakefile|Gemfile|Procfile|Vagrantfile)$/;
/** The first file:line anchor in a text, normalized to file:line; null when none. */
export function firstFileLineAnchor(desc: string): string | null {
  for (const m of desc.replace(URL_RE, " ").matchAll(ANCHOR_RE)) {
    const tok = m[1] as string;
    if (/\.[A-Za-z][A-Za-z0-9]*$/.test(tok) || tok.includes("/") || EXTENSIONLESS.test(tok)) return `${tok}:${m[2]}`;
  }
  return null;
}
