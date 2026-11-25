// loki-ts/src/project_model/guides.ts -- REPO-GUIDES (LOKI_E10_REPO_GUIDES, default on, =0 opts out): what the repository's own guides say about running
// and setting up its tests, read deterministically (no model call). A leaf module (node builtins only) so util/check_result.ts (commandFor, fullSuiteCmd)
// and runner/repo_profile.ts (discoverCommands) both read the one extractor without an import cycle; no existing file reads prose guides.
//
// hermes-agent (2026-11-17, Loki 11.154.0): AGENTS.md says "always `scripts/run_tests.sh`, never bare `pytest`". Loki discovered `python3 -m pytest -q`, ran
// the whole suite twice at intake, and verify then ran 33 files on a virtualenv without pytest; a correct one-line change was labelled FAILED.
//
// A guide is repository CONTENT, never an instruction to Loki beyond a test or setup command:
//   - only text inside a code span or a fenced code block is ever read as a command, and only beside a test word (test, check, verify) or a setup word;
//   - a test command must name something that exists in the checkout: a script file inside it, a Makefile target, a justfile recipe or a package.json script;
//   - what Loki runs is the NORMALIZED form (the script, `make <target>`, `just <recipe>`, `<pm> test`), never the guide's own flags or arguments;
//   - a command with a shell operator, sudo, a delete, push, publish, global install, a download piped into a shell or a path outside the checkout is
//     ignored and disclosed (GuideFacts.ignored), never run and never shown to the model;
//   - setup commands are told to the model, never run by Loki;
//   - the reading is taken once at intake (snapshotGuides) and kept, so a session that edits a guide or adds a script changes nothing in its own run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

export const guidesOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_REPO_GUIDES"] ?? "").trim());

/** The guide files, in the order their word counts: the agent guide first, the README last. */
export const GUIDE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md"] as const;
const JUSTFILES = ["justfile", "Justfile", ".justfile"];
/** Files whose content decides the reading: they join the repo profile's manifest hash so a stored profile is rebuilt when one changes. */
export const GUIDE_HASH_FILES = [...GUIDE_FILES, ...JUSTFILES];

export interface GuideCmd {
  cmd: string; // the normalized command Loki runs from `dir` (tests) or the guide's own text (setup; told to the model, never run)
  source: string; // "AGENTS.md:146"
  file: string; line: number;
  runners: string[]; // the test runners the script, recipe or package script is tied to (it replaces a per-file or per-runner command only for these)
  perFile: "append" | "npm" | `make:${string}` | null; // how one test file is selected, when that is derivable
  needsPath: boolean; // refuses to start without a path (`just test +args`): never the package command
  kind: "script" | "make" | "just" | "npm"; // a script file of the checkout replaces the discovered command for its runners; the others only when a guide forbids the discovered form
  fromGuide: boolean; // false: found in the script table only (justfile, scripts/), named by no guide: a fallback when nothing else is discovered
}
export interface GuideBan { what: string; words: string[]; source: string } // words: [] for a prose-only rule that is told to the model and not enforced
export interface GuideIgnored { cmd: string; source: string; why: string }
export interface GuideFacts { tests: GuideCmd[]; setup: GuideCmd[]; bans: GuideBan[]; ignored: GuideIgnored[] }
const EMPTY: GuideFacts = { tests: [], setup: [], bans: [], ignored: [] };

const TEST_WORD = /\b(?:tests?|testing|check(?:s|ing)?|verify|verification|suite)\b/i;
const SETUP_WORD = /\b(?:set ?up|install(?:ation|ing)?|bootstrap|dependenc(?:y|ies)|environment|getting started|prerequisites?)\b/i;
const TEST_NAME = /(?:^|[_.:-])tests?(?:$|[_.:-])/i; // run_tests.sh, test.sh, test, test:unit, test-all
const SETUP_NAME = /^(?:setup|bootstrap|install)(?:$|[_.:-])/i;
const SHELL_OP = /[;&|`$><(){}\\\n]/;
const COMMAND_WORD = /^(?:sudo|doas|rm|curl|wget|git|npm|pnpm|yarn|bun|make|just|bash|sh|python3?|pip3?|pipx|brew|apt|apt-get|cargo|go|uv|docker|gem|tox|pytest)$/;
const MAX_TEXT = 400_000, MAX_IGNORED = 10, MAX_SETUP = 3, MAX_BANS = 6;

/** Why a guide command is never run or shown, or null. */
export function unsafeGuideCommand(raw: string): string | null {
  const c = raw.trim();
  if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(c)) return "pipes a download into a shell";
  if (/(?:^|[\s;&|])(?:sudo|doas|su)\s/.test(c)) return "uses sudo";
  if (/(?:^|[\s;&|])(?:rm|rmdir|unlink|shred|mkfs|dd)\s/.test(c) || /\bgit\s+(?:clean|reset\s+--hard)\b/.test(c)) return "deletes files";
  if (/\bgit\s+push\b/.test(c)) return "pushes";
  if (/\b(?:npm|pnpm|yarn|bun|cargo|gem|twine|poetry|uv|docker)\s+(?:publish|push|login)\b/.test(c)) return "publishes";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b[^;&|]*\s(?:-g|--global)\b/.test(c) || /\b(?:yarn\s+global\s+add|brew\s+install|apt(?:-get)?\s+install|yum\s+install|dnf\s+install|pacman\s+-S|pipx\s+install|cargo\s+install|go\s+install|uv\s+tool\s+install|gem\s+install)\b/.test(c)) return "installs a global tool";
  if (c.split(/\s+/).some((t) => /^(?:~|\/|\.\.(?:\/|$))/.test(t.replace(/^[A-Za-z_]\w*=/, "")) || /(?:^|\/)\.\.(?:\/|$)/.test(t))) return "names a path outside the checkout";
  if (SHELL_OP.test(c)) return "contains a shell operator";
  return null;
}

const read = (p: string): string => { try { return statSync(p).isFile() ? readFileSync(p, "utf8").slice(0, MAX_TEXT) : ""; } catch { return ""; } };
/** `rel` as a regular file inside `dir` (symlinks resolved), or null. */
function inside(dir: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.split("/").includes("..")) return null;
  try { const root = realpathSync(dir), p = realpathSync(join(dir, rel)), r = relative(root, p); return r && !r.startsWith("..") && !isAbsolute(r) && statSync(p).isFile() ? r : null; } catch { return null; }
}
const RUNNER_WORDS: [RegExp, string][] = [[/\bpytest\b/, "pytest"], [/\bunittest\b/, "unittest"], [/\bvitest\b/, "vitest"], [/\bjest\b/, "jest"], [/\bmocha\b/, "mocha"], [/\bava\b/, "ava"], [/\bbun test\b/, "bun"], [/\bnode\b[^\n]*--test\b/, "node"], [/\bgo test\b/, "go"], [/\bcargo test\b/, "cargo"]];
const runnersIn = (text: string): string[] => RUNNER_WORDS.filter(([re]) => re.test(text)).map(([, r]) => r);
/** The runners a script is tied to: its own text plus one hop into the checkout files it names. */
function scriptRunners(dir: string, text: string): string[] {
  const hop = [...new Set([...text.matchAll(/[\w./-]+\.(?:sh|py|mjs|js|ts)\b/g)].map((m) => m[0]!.replace(/^\.\//, "")))].slice(0, 12).map((f) => inside(dir, f) ?? inside(dir, join("scripts", basename(f)))).filter((f): f is string => f !== null).map((f) => read(join(dir, f)));
  return [...new Set([text, ...hop].flatMap(runnersIn))];
}
const FORWARDS = /"\$@"|\$@|\$\*|\bsys\.argv\b|\bargparse\b|\bprocess\.argv\b/;
const SIMPLE_RUNNER = /^(?:npx\s+)?(?:vitest(?:\s+run)?|jest|mocha|ava|pytest|python3?\s+-m\s+pytest|node\s+--test|bun\s+test)(?:\s+-[\w=-]+)*\s*$/;
const MAKE_FILE_VARS = ["ARGS", "TEST_ARGS", "TESTARGS", "TESTS", "TEST", "FILE", "FILES", "PYTEST_ARGS", "TESTFLAGS"];

interface Recipe { params: string; body: string }
function justRecipes(dir: string): Map<string, Recipe> {
  const out = new Map<string, Recipe>(), text = JUSTFILES.map((f) => read(join(dir, f))).find(Boolean) ?? "", lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^@?([A-Za-z_][\w-]*)((?:[ \t]+[^:=\n]*)?):(?!=)/.exec(lines[i]!); if (!m) continue;
    const body: string[] = []; for (let k = i + 1; k < lines.length && (/^\s/.test(lines[k]!) || lines[k] === ""); k++) body.push(lines[k]!);
    out.set(m[1]!, { params: (m[2] ?? "").trim(), body: body.join("\n") });
  }
  return out;
}
function makeRecipes(dir: string): Map<string, Recipe> {
  const out = new Map<string, Recipe>(), text = ["Makefile", "makefile", "GNUmakefile"].map((f) => read(join(dir, f))).find(Boolean) ?? "", lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*)\s*:(?!=)/.exec(lines[i]!); if (!m) continue;
    const body: string[] = []; for (let k = i + 1; k < lines.length && (lines[k]!.startsWith("\t") || lines[k] === ""); k++) body.push(lines[k]!);
    out.set(m[1]!, { params: "", body: body.join("\n") });
  }
  return out;
}
function pkgScripts(dir: string): Record<string, string> {
  try { const s = (JSON.parse(read(join(dir, "package.json"))) as { scripts?: Record<string, unknown> }).scripts ?? {}; return Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === "string")) as Record<string, string>; } catch { return {}; }
}
const onPath = (bin: string): boolean => { try { return !!Bun.which(bin, { PATH: process.env["PATH"] ?? "" }); } catch { return false; } };
const executable = (p: string): boolean => { try { return (statSync(p).mode & 0o111) !== 0; } catch { return false; } };

type Resolved = { kind: "test" | "setup"; cmd: string; runners: string[]; perFile: GuideCmd["perFile"]; needsPath: boolean; how: GuideCmd["kind"] } | null;
/** One candidate (the text of a code span or a code-block line) as a command of this checkout, or null. `raw` has already passed unsafeGuideCommand. */
function resolveCandidate(dir: string, raw: string, ctx: { test: boolean; setup: boolean }, tables: { just: Map<string, Recipe>; make: Map<string, Recipe>; scripts: Record<string, string> }): Resolved {
  const toks = raw.trim().replace(/^\$\s+/, "").split(/\s+/).filter(Boolean); if (!toks.length || toks.length > 12) return null;
  const hasArg = toks.length > 1;
  const [t0, t1, t2] = toks;
  if (t0 === "make" && t1 && /^[A-Za-z][\w-]*$/.test(t1)) {
    const r = tables.make.get(t1); if (!r || !ctx.test || !TEST_NAME.test(t1) || !onPath("make")) return null;
    const v = MAKE_FILE_VARS.find((x) => new RegExp(`\\$[({]${x}[)}]`).test(r.body));
    return { kind: "test", cmd: `make ${t1}`, runners: scriptRunners(dir, r.body), perFile: v ? `make:${v}` : null, needsPath: false, how: "make" };
  }
  if (t0 === "just" && t1 && /^[A-Za-z_][\w-]*$/.test(t1)) {
    const r = tables.just.get(t1); if (!r || !ctx.test || !TEST_NAME.test(t1) || !onPath("just")) return null;
    return { kind: "test", cmd: `just ${t1}`, runners: scriptRunners(dir, r.body), perFile: r.params ? "append" : null, needsPath: /^\+/.test(r.params), how: "just" };
  }
  if (t0 && /^(?:npm|pnpm|yarn|bun)$/.test(t0)) {
    const name = t1 === "test" ? "test" : t1 === "run" && t2 ? t2 : null, body = name ? tables.scripts[name] : undefined;
    if (!name || body === undefined || !ctx.test || !TEST_NAME.test(name) || /no test specified/i.test(body) || !onPath(t0)) return null;
    return { kind: "test", cmd: name === "test" ? `${t0} test` : `${t0} run ${name}`, runners: [...new Set([...runnersIn(body), "npm"])], perFile: SIMPLE_RUNNER.test(body.trim()) ? "npm" : null, needsPath: false, how: "npm" };
  }
  // A script file of this checkout, optionally behind its interpreter.
  const viaInterp = t0 !== undefined && /^(?:bash|sh|python3?|node)$/.test(t0) && t1 !== undefined, pathTok = viaInterp ? t1! : t0!;
  if (!/^[\w.@/-]+$/.test(pathTok)) return null;
  const rel = inside(dir, pathTok.replace(/^\.\//, "")); if (!rel) return null;
  if (rel.split("/").slice(0, -1).some((seg) => /^(?:tests?|__tests__|specs?)$/.test(seg))) return null; // a file under a test directory is a test, not a runner
  const base = basename(rel), abs = join(dir, rel), text = read(abs);
  const isTestName = TEST_NAME.test(base.replace(/\.(?:sh|bash|py|js|mjs|ts)$/, "")) && /^(?:run[_-]?)?tests?(?:[_-]\w+)?(?:\.(?:sh|bash|py|js|mjs))?$/i.test(base);
  const runnable = executable(abs) ? `./${rel}` : /\.(?:sh|bash)$/.test(base) ? `bash ${rel}` : null;
  if (isTestName && ctx.test) {
    // A test FILE is never a test command: the script must be runnable and must not be a pytest or unittest module without a shebang.
    if (!runnable || (/\.py$/.test(base) && !text.startsWith("#!"))) return null;
    return { kind: "test", cmd: runnable, runners: scriptRunners(dir, text), perFile: FORWARDS.test(text) || (hasArg && toks.slice(viaInterp ? 2 : 1).some((a) => !a.startsWith("-"))) ? "append" : null, needsPath: false, how: "script" };
  }
  if (SETUP_NAME.test(base) && ctx.setup && (runnable || viaInterp)) return { kind: "setup", cmd: raw.trim().replace(/^\$\s+/, ""), runners: [], perFile: null, needsPath: false, how: "script" };
  return null;
}
/** Setup commands that name no checkout file but are the ecosystem's own install: told to the model as written. ReDoS: a flag's space-separated value never starts with a token that is itself a whole flag (`--x` ending at a space or the end), because that text already parses as the next flag; the accepted strings are unchanged and each now has one parse. */
const KNOWN_SETUP = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:ci|install)(?:\s+--frozen-lockfile)?|uv\s+sync(?:\s+--[\w-]+(?:=[\w.-]+|[ ](?!--[\w-]+(?:\s|$))[\w.-]+)?)*|poetry\s+install(?:\s+--[\w-]+(?:=[\w.,-]+|[ ](?!--[\w-]+(?:\s|$))[\w.,-]+)?)*|python3?\s+-m\s+pip\s+install\s+-(?:e|r)\s+[\w.\[\],/-]+|pip3?\s+install\s+-(?:e|r)\s+[\w.\[\],/-]+|just\s+setup|make\s+(?:setup|install|bootstrap|deps))$/;

const BAN_RE = /(?:\b(?:never|do not|don't|must not|avoid|rather than|instead of)|,\s*not)\s+(?:to\s+)?(?:(?:use|run|call|invoke|running|calling|using)\s+)?(?:an?\s+|the\s+)?(?:(?:bare|raw|plain|direct|directly)\s+)?`([^`\n]+)`/gi;
const GENERIC_RUNNER = /^(?:python3?\s+-m\s+)?(?:pytest|unittest|jest|vitest|mocha|tox|nose2?)\b|^(?:npm|pnpm|yarn|bun|go|cargo)\s+test\b/;
const FULL_SUITE_BAN = /\b(?:never|do not|don't|must not|avoid)\s+(?:run(?:ning)?\s+)?the\s+(?:full|whole|entire)\s+(?:test\s+)?suite\b/i;

/** The pure extractor: reads the guides, justfile and scripts/ of `dir` and nothing else; never writes, never runs a guide's command. */
export function readGuides(dir: string): GuideFacts {
  const facts: GuideFacts = { tests: [], setup: [], bans: [], ignored: [] };
  let tables: Parameters<typeof resolveCandidate>[3];
  try { tables = { just: justRecipes(dir), make: makeRecipes(dir), scripts: pkgScripts(dir) }; } catch { return EMPTY; }
  const seen = new Set<string>();
  const add = (raw: string, file: string, line: number, context: string, fromGuide = true): void => {
    const ctx = { test: TEST_WORD.test(context), setup: SETUP_WORD.test(context) }; if (!ctx.test && !ctx.setup) return;
    const source = `${file}:${line}`, shown = raw.trim().replace(/^\$\s+/, ""); if (!shown || shown.length > 200) return;
    const text = shown.replace(/<[\w ./|-]+>|\[[\w ./|-]+\]|\.\.\./g, "ARG"); // a placeholder (<paths>, [file], ...) is an argument, not a shell operator
    const why = unsafeGuideCommand(text);
    if (why) { // disclosed only when it reads as a command (a known command word or a path first), never for a code identifier that happens to sit beside a test word
      const first = text.split(/\s+/)[0]!, commandLike = COMMAND_WORD.test(first) ? text.includes(" ") : first.includes("/") && (TEST_NAME.test(basename(first).replace(/\.\w+$/, "")) || SETUP_NAME.test(basename(first)));
      if (commandLike && facts.ignored.length < MAX_IGNORED && !facts.ignored.some((g) => g.cmd === shown.slice(0, 120))) facts.ignored.push({ cmd: shown.slice(0, 120), source, why });
      return;
    }
    let r: Resolved = null; try { r = resolveCandidate(dir, text, ctx, tables); } catch { r = null; }
    if (!r && ctx.setup && KNOWN_SETUP.test(text) && (!/^(?:just|make)\s/.test(text) || onPath(text.split(/\s+/)[0]!))) r = { kind: "setup", cmd: text, runners: [], perFile: null, needsPath: false, how: "script" };
    if (!r || seen.has(`${r.kind}\0${r.cmd}`)) return;
    seen.add(`${r.kind}\0${r.cmd}`);
    const g: GuideCmd = { cmd: r.cmd, source, file, line, runners: r.runners, perFile: r.perFile, needsPath: r.needsPath, kind: r.how, fromGuide };
    if (r.kind === "test") facts.tests.push(g); else if (facts.setup.length < MAX_SETUP) facts.setup.push(g);
  };
  for (const file of GUIDE_FILES) {
    const text = read(join(dir, file)); if (!text) continue;
    const lines = text.split("\n"); let fence: string | null = null, fenceCtx = "", heading = "";
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!, f = /^\s*(```+|~~~+)/.exec(l);
      if (f) { if (fence === null) { fence = f[1]![0]!; const prev = lines.slice(Math.max(0, i - 4), i).filter((x) => x.trim() !== "").slice(-2).join(" "); fenceCtx = `${heading} ${prev}`; } else if (f[1]![0] === fence) fence = null; continue; }
      if (fence !== null) { if (!/^\s*(?:#|\/\/)/.test(l) && l.trim() !== "") add(l, file, i + 1, fenceCtx); continue; }
      if (/^#{1,6}\s/.test(l)) heading = l;
      for (const m of l.matchAll(/`([^`\n]+)`/g)) add(m[1]!, file, i + 1, l);
      for (const m of l.matchAll(BAN_RE)) {
        const what = m[1]!.trim(), words = what.replace(/^python3?\s+-m\s+/, "").split(/\s+/);
        if (GENERIC_RUNNER.test(what) && facts.bans.length < MAX_BANS && !facts.bans.some((b) => b.what === what)) facts.bans.push({ what, words, source: `${file}:${i + 1}` });
      }
      if (FULL_SUITE_BAN.test(l) && facts.bans.length < MAX_BANS && !facts.bans.some((b) => b.what === "the full suite")) facts.bans.push({ what: "the full suite", words: [], source: `${file}:${i + 1}` });
    }
  }
  // The manifest's own script table, after every guide: a `test` recipe in a justfile and scripts/test*, scripts/run_tests*.
  const jf = JUSTFILES.find((f) => read(join(dir, f)) !== "");
  if (jf) for (const name of ["test", "test-all"]) if (tables.just.has(name)) add(`just ${name}`, jf, 1 + read(join(dir, jf)).split("\n").findIndex((x) => new RegExp(`^@?${name}\\b[^:=]*:(?!=)`).test(x)), "test", false);
  for (const s of ["scripts/run_tests.sh", "scripts/run_tests", "scripts/run-tests.sh", "scripts/test.sh", "scripts/test"]) if (inside(dir, s)) add(s, s, 1, "test", false);
  return facts;
}

/** A discovered generic command line (or argv joined by spaces) that a guide forbids, with the rule; null when none does. */
export function bannedBy(facts: GuideFacts, cmdline: string): GuideBan | null {
  const toks = cmdline.split(/\s+/).filter(Boolean).map((t) => basename(t.replace(/^['"(]+|['")]+$/g, "")));
  for (const b of facts.bans) {
    if (!b.words.length) continue;
    for (let i = 0; i + b.words.length <= toks.length; i++) if (b.words.every((w, k) => toks[i + k] === w)) return b;
  }
  return null;
}

// ---- the intake reading, kept for the run ------------------------------------------------------------------------------------------------------
const snap = new Map<string, GuideFacts>(), roots = new Set<string>(), used = new Map<string, Set<string>>(), noState = new Set<string>();
const real = (d: string): string => { try { return realpathSync(d); } catch { return d; } };
const statePath = (repoDir: string): string => join(repoDir, ".loki", "state", "repo-guides.json");
const headOf = (repoDir: string): string => { try { const r = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }); return r.status === 0 ? r.stdout.trim() : ""; } catch { return ""; } };
/** Intake: read the guides of the repository root and of each directory in `dirs` (repo-relative package dirs), keep the reading for this process and
 *  write it to .loki/state/repo-guides.json (Loki's own state, excluded from every diff) for a later process of the same run. Never throws. */
export function snapshotGuides(repoDir: string, dirs: readonly string[] = []): GuideFacts {
  const root = real(repoDir), rec: Record<string, GuideFacts> = {};
  try {
    for (const d of [...new Set([".", ...dirs])].slice(0, 200)) { const abs = d === "." ? root : real(join(root, d)); if (abs !== root && !abs.startsWith(`${root}/`)) continue; const f = guidesOn() ? readGuides(abs) : EMPTY; snap.set(abs, f); rec[relative(root, abs) || "."] = f; }
    roots.add(root); used.delete(root); noState.delete(root);
    mkdirSync(join(root, ".loki", "state"), { recursive: true });
    const tmp = `${statePath(root)}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ version: 1, head: headOf(root), dirs: rec }, null, 2) + "\n"); renameSync(tmp, statePath(root));
  } catch { /* no record: a later process reads the tree as it is */ }
  return snap.get(root) ?? EMPTY;
}
/** A snapshotted root at or above `abs`, loading the state file of `repoDir` once when this process has none (only while HEAD is the commit it was taken at). */
function rootOf(abs: string, repoDir?: string): string | null {
  for (const r of roots) if (abs === r || abs.startsWith(`${r}/`)) return r;
  const cand = repoDir ? real(repoDir) : abs;
  if (noState.has(cand)) return null;
  if (!existsSync(statePath(cand))) return null; // the usual case for a base worktree: no record, read the tree
  try {
    const j = JSON.parse(readFileSync(statePath(cand), "utf8")) as { version?: number; head?: string; dirs?: Record<string, GuideFacts> };
    if (j.version !== 1 || !j.dirs || !j.head || j.head !== headOf(cand)) { noState.add(cand); return null; }
    for (const [d, f] of Object.entries(j.dirs)) if (f && Array.isArray(f.tests) && Array.isArray(f.setup) && Array.isArray(f.bans) && Array.isArray(f.ignored)) snap.set(d === "." ? cand : join(cand, d), f);
    roots.add(cand);
    return abs === cand || abs.startsWith(`${cand}/`) ? cand : null;
  } catch { noState.add(cand); return null; }
}
/** The guide facts of one directory: the intake reading when its repository has one (a directory not read then has none: a guide that appeared
 *  during the run is not trusted), else the tree as it is (a base worktree, `loki doctor`, a unit test). `repoDir`: the repository root, when known. */
export function guidesFor(dir: string, repoDir?: string): GuideFacts {
  if (!guidesOn()) return EMPTY;
  const abs = real(dir);
  try { if (rootOf(abs, repoDir)) return snap.get(abs) ?? EMPTY; return readGuides(abs); } catch { return EMPTY; }
}
/** Test seam: forget every intake reading held by this process. */
export function resetGuides(): void { snap.clear(); roots.clear(); used.clear(); noState.clear(); }

const note = (repoDir: string | undefined, dir: string, line: string): void => { const k = real(repoDir ?? dir); used.set(k, (used.get(k) ?? new Set()).add(line)); };
const shq = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
/** The runners a generic command line names (a project model's test command). */
export const cmdRunners = (cmdline: string): string[] => runnersIn(cmdline.replace(/\b(?:npm|pnpm|yarn|bun) (?:run )?test\b/, "$& npm"));

/** Whether a documented command replaces the discovered one for `runner`: a script file of the checkout tied to that runner does (never for Go, whose pass
 *  is read only from a `go test -json` stream); a make, just or package-script command does only when a guide forbids the discovered form (`banned`). */
const replaces = (t: GuideCmd, runners: readonly string[], banned: boolean): boolean => t.fromGuide && (banned ? t.runners.length === 0 || t.runners.some((r) => runners.includes(r)) : t.kind === "script" && t.runners.some((r) => r !== "go" && runners.includes(r)));
const noAlternative = (repoDir: string | undefined, dir: string, b: GuideBan): null => { note(repoDir, dir, `the guide forbids \`${b.what}\` (${b.source}) but names no command Loki can run in its place; the discovered command ran`); return null; };
/** The documented command for the whole package in `dir`, when it replaces `generic` (the discovered command, run by `runners`); null keeps the discovered one. */
/** A documented command as an argv whose test file (and any flag a caller appends: the Wall's `-rfE`, the exec spec's `--junitxml`) stays a separate word, so
 *  consumers that read or extend a check's arguments keep working. A script of the checkout starts through `env` (the runner resolves the first word on PATH). */
function guideArgv(cmd: string, tail: string[]): string[] { const w = cmd.split(" "); return [...(w[0]!.startsWith("./") ? ["env"] : []), ...w, ...tail]; }
export interface GuideRun { argv: string[]; line: string; source: string }
export function guideSuite(dir: string, runners: readonly string[], generic: string, repoDir?: string): GuideRun | null {
  const f = guidesFor(dir, repoDir), banned = bannedBy(f, generic), doc = f.tests.find((t) => !t.needsPath && replaces(t, runners, banned !== null));
  if (!doc) return banned ? noAlternative(repoDir, dir, banned) : null;
  note(repoDir, dir, `test command from ${doc.source}: ${doc.cmd}`);
  return { argv: guideArgv(doc.cmd, []), line: doc.cmd, source: doc.source };
}
/** The documented way to run ONE test file (`file` relative to `dir`) of `runner`; null keeps the discovered per-file command. When a guide forbids the
 *  discovered form and names no way to select a file, the documented package command runs instead (and the receipt says so), never the forbidden form. */
export function guideFile(dir: string, runner: string, file: string, generic: string, repoDir?: string, onlyIfBanned = false): GuideRun | null {
  if (!file) return null;
  const f = guidesFor(dir, repoDir), banned = bannedBy(f, generic);
  if (onlyIfBanned && !banned) return null; // the root guide speaks for a package below the root only through an explicit prohibition
  const one = f.tests.find((t) => t.perFile !== null && replaces(t, [runner], banned !== null));
  if (one) {
    const mk = one.perFile !== "append" && one.perFile !== "npm" ? one.perFile!.slice(5) : null; // make: the file travels in a variable, so a flag a caller appends is not handed to make
    const argv = mk ? ["bash", "-c", `${one.cmd} ${mk}="$1"`, "loki-guide-test", file] : guideArgv(one.cmd, one.perFile === "npm" && one.cmd.startsWith("npm ") ? ["--", file] : [file]);
    note(repoDir, dir, `test command from ${one.source}: ${one.cmd} <file>`);
    return { argv, line: mk ? `${one.cmd} ${mk}=${shq(file)}` : argv.filter((w) => w !== "env").map(shq).join(" "), source: one.source };
  }
  if (!banned) return null;
  const pkg = f.tests.find((t) => !t.needsPath && replaces(t, [runner], true));
  if (!pkg) return noAlternative(repoDir, dir, banned);
  note(repoDir, dir, `test command from ${pkg.source}: ${pkg.cmd} ran for each test file (the guide forbids \`${banned.what}\` and names no way to select one file)`);
  return { argv: guideArgv(pkg.cmd, []), line: pkg.cmd, source: pkg.source };
}
/** Receipt lines: which documented command ran and where it came from, and each guide command that was ignored and why. */
export function guideNotes(repoDir: string): string[] {
  if (!guidesOn()) return [];
  const root = real(repoDir), out = [...(used.get(root) ?? [])];
  try { for (const [d, f] of snap) if (d === root || d.startsWith(`${root}/`)) for (const g of f.ignored) out.push(`guide command ignored (${g.why}): \`${g.cmd}\` (${relative(root, d) ? `${relative(root, d)}/` : ""}${g.source})`); } catch { /* notes only */ }
  return [...new Set(out)];
}
/** The per-repository sentence of the implement and fix briefs (e10ext/context.ts REPO_GUIDE_LEAD leads it); "" when the guides say nothing usable. */
export function guideSentence(dir: string, repoDir?: string): string {
  const f = guidesFor(dir, repoDir), named = f.tests.filter((x) => x.fromGuide), t = named.find((x) => x.perFile !== null) ?? named[0], parts: string[] = [];
  if (t) parts.push(`run tests with \`${t.cmd}${t.perFile === "append" ? " <test file>" : t.perFile === "npm" ? (t.cmd.startsWith("npm ") ? " -- <test file>" : " <test file>") : t.perFile ? ` ${t.perFile.slice(5)}=<test file>` : ""}\` (from ${t.source})`);
  for (const s of f.setup.slice(0, 2)) parts.push(`if the tests cannot start, set up with \`${s.cmd}\` (from ${s.source})`);
  for (const b of f.bans.slice(0, 3)) parts.push(b.words.length ? `do not run bare \`${b.what}\` (${b.source})` : `do not run ${b.what} (${b.source})`);
  return parts.length ? `${parts.join("; ")}.` : "";
}
