// loki-ts/src/runner/repo_profile.ts -- harness intelligence feature 6.
//
// A LOCAL, EVIDENCE-BACKED repository profile: durable facts about this repo
// (build command, test command, language, package manager) derived ONLY from
// files that exist in the repo, each carrying the path that proves it.
//
// Three properties do the real work here:
//
//   CONTENT HASH  -- the profile records a hash over the evidence inputs. If a
//                    manifest file changes, the hash no longer matches and the
//                    profile is stale. This is what stops a profile from
//                    asserting "the test command is X" after someone changed it.
//   FRESHNESS     -- a TTL, independently of the hash, so a profile cannot
//                    silently outlive the repo state it was derived from.
//   BOUNDED       -- the prompt fragment is hard-capped in characters. An
//                    unbounded profile is a prompt-cache buster and a token leak.
//
// PRIVACY / NAMESPACE. The profile is namespaced per repository and records only
// facts derived from tracked repo files. It never records absolute host paths,
// environment values, or file CONTENTS -- only which file proved which fact.
// See redactEvidence() below, which is the single enforcement point.
//
// DEFAULT OFF (LOKI_REPO_PROFILE). With the flag unset, profileFragment()
// returns "" and nothing is read or written, so build_prompt parity is exact.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { comparableIds, errorsById, failIds, idNamesFile, lineNamesChange, noiseOnlyErrors, sameErrors, unhandledBlock } from "../engine10/failures.ts";
import { baseRedShapeOn, classifyCheck, emptyDiscovery, exitCodedId, failureShape, goRunner, isExitCodedScript, plainTestEnv, resolveTool, stripAnsi, type Classified } from "../util/check_result.ts";
import { safeGit, safeGitSpawn } from "../util/safe_git.ts";
import { lokiDir } from "../util/paths.ts";
import { atomicWriteFileSync } from "./state.ts";
import { inWorkspace, pkgWorkspaces, pnpmWorkspaces } from "../util/lock_ecosystems.ts";

// Bumped when the record shape changes. An unrecognized version is treated as
// ABSENT, never as an error -- an older binary reading a newer artifact must
// degrade to default-off behavior rather than crash.
export const PROFILE_SCHEMA_VERSION = 1;

const DEFAULT_TTL_SECONDS = 86_400; // 24h
const DEFAULT_MAX_CHARS = 2_000;
const TRUNCATION_MARKER = "\n- (truncated)";

export interface ProfileFact {
  readonly key: string;
  readonly value: string;
  /** Repo-relative path of the file that proves this fact. Never absolute. */
  readonly evidence: string;
}

export interface RepoProfile {
  readonly schema_version: number;
  /** Namespace = repo identity. Basename only; never an absolute host path. */
  readonly namespace: string;
  /** Hash over the evidence inputs. Mismatch => stale. */
  readonly content_hash: string;
  /** UTC ISO-8601. */
  readonly generated_at: string;
  /** HEAD sha + tracked-dirty flag the profile was derived at. Absent outside git. */
  readonly cache_key?: string;
  readonly facts: readonly ProfileFact[];
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function profileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["LOKI_REPO_PROFILE"] === "1";
}

// redactEvidence -- the single privacy enforcement point.
//
// An evidence path must be REPO-RELATIVE. An absolute path leaks the host
// layout (usernames, org names, directory structure) into a prompt and into a
// durable artifact. We reduce anything absolute to its basename rather than
// dropping it, so the fact keeps its proof without the leak.
export function redactEvidence(path: string, repoRoot: string): string {
  if (!isAbsolute(path)) return path;
  const root = resolve(repoRoot);
  const abs = resolve(path);
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return basename(abs);
}

function extractFacts(repoRoot: string): ProfileFact[] {
  const facts: ProfileFact[] = [];
  const pkgPath = resolve(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      // Record that a script EXISTS, not its body: a script body can contain
      // tokens, hostnames, or deploy targets. The name is the useful fact.
      for (const name of ["build", "test", "lint"]) {
        if (typeof scripts[name] === "string" && scripts[name] !== "") {
          facts.push({ key: `script.${name}`, value: name, evidence: "package.json" });
        }
      }
      facts.push({ key: "language", value: "javascript", evidence: "package.json" });
    } catch {
      // Malformed package.json yields no facts; never throws.
    }
  }
  for (const [rel, key, value] of [
    ["requirements.txt", "language", "python"],
    ["pyproject.toml", "language", "python"],
    ["Cargo.toml", "language", "rust"],
    ["go.mod", "language", "go"],
    ["Makefile", "build.system", "make"],
  ] as const) {
    if (existsSync(resolve(repoRoot, rel))) {
      facts.push({ key, value, evidence: rel });
    }
  }
  return facts;
}

function profilePath(lokiDirOverride?: string): string {
  return resolve(lokiDirOverride ?? lokiDir(), "profile", "repo-profile.json");
}

export interface BuildProfileOpts {
  readonly repoRoot: string;
  readonly lokiDirOverride?: string;
  readonly now?: Date;
}

// buildProfile -- derive and persist the profile. Caller decides when; this
// never self-triggers, so it cannot surprise a default-path run.
export function buildProfile(opts: BuildProfileOpts, cacheKey: string | null = null): RepoProfile {
  const root = resolve(opts.repoRoot);
  const facts = extractFacts(root).map((f) => ({
    ...f,
    evidence: redactEvidence(f.evidence, root),
  }));
  const profile: RepoProfile = {
    schema_version: PROFILE_SCHEMA_VERSION,
    // Namespace is the repo BASENAME, never the absolute path.
    namespace: basename(root),
    content_hash: manifestHash(root),
    generated_at: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(cacheKey !== null ? { cache_key: cacheKey } : {}),
    facts,
  };
  const target = profilePath(opts.lokiDirOverride);
  mkdirSync(resolve(target, ".."), { recursive: true });
  atomicWriteFileSync(target, JSON.stringify(profile, null, 2) + "\n");
  return profile;
}

// repoCacheKey -- HEAD sha plus a tracked-files dirty flag. Null outside git or
// on any git failure, which disables the cache (always rescan).
function repoCacheKey(root: string): string | null {
  try {
    const head = safeGit(root, ["rev-parse", "HEAD"]).trim();
    if (!head) return null;
    const dirty = safeGit(root, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
    return `${head}:${dirty ? "dirty" : "clean"}`;
  } catch {
    return null;
  }
}

// buildProfileCached -- reuse the persisted profile when it is still fresh and
// was derived at the same HEAD and dirty flag, so a resumed run skips the scan.
// A new commit, a dirty-state flip, a manifest edit or TTL expiry rebuilds.
export function buildProfileCached(opts: BuildProfileOpts & { env?: NodeJS.ProcessEnv }): RepoProfile {
  const key = repoCacheKey(resolve(opts.repoRoot));
  if (key !== null) {
    const r = readProfile(opts);
    if (r.status === "fresh" && r.profile && r.profile.cache_key === key) return r.profile;
  }
  return buildProfile(opts, key);
}

export type ProfileStatus = "fresh" | "absent" | "stale_hash" | "stale_ttl" | "unreadable";

export interface ReadProfileResult {
  readonly status: ProfileStatus;
  readonly profile: RepoProfile | null;
}

// readProfile -- load and VALIDATE. A profile is usable only when it parses,
// its schema version is recognized, its content hash still matches the repo,
// and it is within TTL. Every other outcome is a status, never an exception.
export function readProfile(opts: BuildProfileOpts & { env?: NodeJS.ProcessEnv }): ReadProfileResult {
  const env = opts.env ?? process.env;
  const root = resolve(opts.repoRoot);
  const target = profilePath(opts.lokiDirOverride);
  if (!existsSync(target)) return { status: "absent", profile: null };

  let parsed: RepoProfile;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8")) as RepoProfile;
  } catch {
    return { status: "unreadable", profile: null };
  }
  // Forward compatibility: an unknown schema version is ABSENT, not an error.
  if (!parsed || parsed.schema_version !== PROFILE_SCHEMA_VERSION) {
    return { status: "absent", profile: null };
  }

  if (parsed.content_hash !== manifestHash(root)) {
    return { status: "stale_hash", profile: parsed };
  }

  const ttl = num(env, "LOKI_REPO_PROFILE_TTL_SECONDS", DEFAULT_TTL_SECONDS);
  const generated = Date.parse(parsed.generated_at);
  const now = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(generated) || now - generated > ttl * 1000) {
    return { status: "stale_ttl", profile: parsed };
  }

  return { status: "fresh", profile: parsed };
}

// profileFragment -- the ONLY function that produces prompt text.
//
// Returns "" when the feature is off, or when the profile is anything other
// than fresh. A stale profile injecting stale facts is worse than no profile:
// it is confidently wrong. Output is hard-capped; over-cap is truncated at a
// line boundary with an explicit marker, never silently.
export function profileFragment(
  opts: BuildProfileOpts & { env?: NodeJS.ProcessEnv },
): string {
  const env = opts.env ?? process.env;
  if (!profileEnabled(env)) return "";

  const { status, profile } = readProfile({ ...opts, env });
  if (status !== "fresh" || profile === null || profile.facts.length === 0) return "";

  const cap = num(env, "LOKI_REPO_PROFILE_MAX_CHARS", DEFAULT_MAX_CHARS);
  const header = "Repository profile (evidence-backed, local):";
  const lines = profile.facts.map((f) => `- ${f.key}=${f.value} (from ${f.evidence})`);

  let out = header;
  let truncated = false;
  for (const line of lines) {
    // +1 for the newline. Reserve room for the truncation marker so the marker
    // itself can never push the result over the cap.
    if (out.length + line.length + 1 > cap - TRUNCATION_MARKER.length) {
      truncated = true;
      break;
    }
    out += "\n" + line;
  }
  if (truncated) out += TRUNCATION_MARKER;
  return out;
}

// ---------------------------------------------------------------------------
// REPOMEM: the repo's build/test/lint/typecheck commands and a baseline test run on the untouched tree, persisted to
// .loki/state/repo-profile.json (CommandProfile) so the user never explains how the repo works twice. Discovery reads manifests only
// (package.json, Makefile, pyproject/tox/pytest.ini, go.mod, Cargo.toml, CI workflows, read-only); the one executed command is the test
// command, on the pristine base tree, so a later failure is attributable: pre-existing (in the baseline) or introduced. Reused while the
// manifest hash matches (manifestHash, shared with the facts profile above); the baseline alone is re-run when HEAD moved. Never throws
// into the caller: no profile is a valid state. Written by engine10 intake, read by verify (attribute), the implementer brief and `loki doctor --repo`.
// ---------------------------------------------------------------------------
export type CmdKind = "test" | "lint" | "typecheck" | "build";
export interface ProfileCommand {
  kind: CmdKind;
  cmd: string;
  source: string; // manifest file the command came from
  validated: boolean | null; // true: executed on the untouched tree and ran to completion; false: could not run; null: discovered, not executed
  exit_code: number | null;
  duration_s: number | null;
  failing_ids: string[]; // test kind only, [] when the runner output has no parseable ids
  note?: string;
  fix?: string; // FR05: how to make a not-runnable row runnable
}
export interface CommandProfile {
  version: 1;
  revision: string; // git HEAD the baseline ran on
  manifest_hash: string;
  created_at: string;
  commands: ProfileCommand[];
  baseline: { ran: boolean; command: string | null; exit_code: number | null; duration_s: number | null; timed_out: boolean; failing_ids: string[]; attributable: boolean; reason?: string; zero_tests?: boolean; failing_unhandled?: string[]; failing_errors?: Record<string, string[]> /* FireLater#21: errorsById of the run, so a full suite is excused only for the same errors */; failing_shape?: string /* BASE-RED-SHAPE: failureShape of a red run whose ids were not parseable */; flaky_ids?: string[] /* ids that failed on exactly one of two base passes */; flaky_probe?: string /* "done", or why the second pass was skipped; absent on an entry written before the probe */ };
  suites?: (CommandProfile["baseline"] & { name: string })[]; // FC-BASELINE-PER-PACKAGE: one per full-suite command verify runs; `command` is the check's cmd
}
export interface BaselineRun { code: number | null; timedOut: boolean; out: string; missing?: boolean }
export type BaselineRunner = (cmd: string, cwd: string, timeoutMs: number) => BaselineRun;

export const commandProfilePath = (repoDir: string): string => join(repoDir, ".loki", "state", "repo-profile.json");
/** One command's baseline budget: the same 5 minutes deep.ts gives that command's own run on the change (FULL_SUITE_TIMEOUT_MS is derived from this), so a suite that completes on head is never cut short on base (v131: tq's 250 s npm test got 60 s on base, timed out, and its pre-existing red was blamed on the change). */
export const BASELINE_CMD_TIMEOUT_S = 300;
/** A cut entry measured with a shorter budget than the current one is measured again; one cut at the current budget is kept (a hanging suite is not re-run for 5 minutes every time). */
/** A baseline command never gets more than a third of the run's overall cap. */
/** R3 LOKI_E10_INTAKE_CAP_S (default 180; =0/off restores the per-command caps alone): one budget, in seconds, for all of intake's baseline test runs together (the root
 *  baseline, its rerun after an install, and the per-suite baselines). Before it, a suite that ran past the 300 s per-command cap was measured twice under two names, so
 *  intake spent 600 s on two cut-off runs that excuse nothing. A run cut by the budget is recorded as cut off, as before. The dependency install keeps its own cap. */
export const INTAKE_CAP_DEFAULT_S = 180;
export const intakeCapS = (env: NodeJS.ProcessEnv = process.env): number | null => { const v = (env.LOKI_E10_INTAKE_CAP_S ?? "").trim(); if (/^(0|off|false|no)$/i.test(v)) return null; const n = Number(v); return v !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : INTAKE_CAP_DEFAULT_S; };
export const baselineCmdS = (capS: number | undefined): number => Math.max(1, Math.min(BASELINE_CMD_TIMEOUT_S, Math.floor((capS ?? Infinity) / 3)));
const cutShort = (b: { timed_out: boolean; duration_s: number | null } | undefined, tmoS: number): boolean => !!b?.timed_out && (b.duration_s ?? 0) < tmoS - 1;
export const MANIFESTS = ["requirements.txt", "package.json", "Makefile", "makefile", "GNUmakefile", "pyproject.toml", "tox.ini", "pytest.ini", "setup.cfg", "go.mod", "Cargo.toml", "tsconfig.json"];
const NO_TEST = /no test specified/i;

const read = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
function workflowFiles(repoDir: string): string[] {
  try { return readdirSync(join(repoDir, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(".github", "workflows", f)); } catch { return []; }
}
/** sha256 over the name and content of every manifest and CI workflow file present, sorted: any edit to how the repo builds or tests changes it. */
export function manifestHash(repoDir: string): string {
  const h = createHash("sha256");
  for (const f of [...MANIFESTS, ...workflowFiles(repoDir)].sort()) {
    const p = join(repoDir, f);
    if (existsSync(p)) h.update(`${f}\0${read(p)}\0`);
  }
  return h.digest("hex");
}
function pkgManager(repoDir: string): string {
  if (existsSync(join(repoDir, "bun.lock")) || existsSync(join(repoDir, "bun.lockb"))) return "bun";
  if (existsSync(join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoDir, "yarn.lock"))) return "yarn";
  return "npm";
}
const entry = (kind: CmdKind, cmd: string, source: string): ProfileCommand => ({ kind, cmd, source, validated: null, exit_code: null, duration_s: null, failing_ids: [] });

/** Commands named by the repo's own manifests, in a fixed order (node, make, python, go, cargo, CI). The first test command is the baseline one. */
export function discoverCommands(repoDir: string, pmDir: string = repoDir): ProfileCommand[] { // pmDir: where the lockfile naming the package manager lives (a workspace member's is the workspace root)
  const out: ProfileCommand[] = [];
  const pj = read(join(repoDir, "package.json"));
  if (pj) {
    let scripts: Record<string, unknown> = {}, hasTs = false;
    try { const j = JSON.parse(pj) as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }; scripts = j.scripts ?? {}; hasTs = !!(j.dependencies?.typescript ?? j.devDependencies?.typescript); } catch { /* malformed manifest: nothing to discover */ }
    const pm = pkgManager(pmDir), run = (n: string): string => (n === "test" ? `${pm} test` : `${pm} run ${n}`);
    const has = (n: string): boolean => typeof scripts[n] === "string" && !(n === "test" && NO_TEST.test(String(scripts[n])));
    const pick = (kind: CmdKind, names: string[]): void => { const n = names.find(has); if (n) out.push(entry(kind, run(n), "package.json")); };
    pick("test", ["test"]); pick("lint", ["lint"]); pick("typecheck", ["typecheck", "type-check", "tsc"]);
    // No typecheck script: a TypeScript repo (tsconfig.json plus a typescript dependency) still gets a config-based one.
    if (hasTs && existsSync(join(repoDir, "tsconfig.json")) && !out.some((e) => e.kind === "typecheck")) out.push(entry("typecheck", `${({ bun: "bunx", pnpm: "pnpm exec", yarn: "yarn" } as Record<string, string>)[pm] ?? "npx"} tsc --noEmit`, "tsconfig.json"));
    pick("build", ["build"]);
  }
  const mk = ["Makefile", "makefile", "GNUmakefile"].map((f) => [f, read(join(repoDir, f))] as const).find(([, t]) => t);
  if (mk) {
    const targets = new Set([...mk[1].matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]!));
    const pick = (kind: CmdKind, names: string[]): void => { const n = names.find((x) => targets.has(x)); if (n) out.push(entry(kind, `make ${n}`, mk[0])); };
    pick("test", ["test", "check"]); pick("lint", ["lint"]); pick("typecheck", ["typecheck", "mypy"]); pick("build", ["build", "all"]);
  }
  const pyTxt = ["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg"].map((f) => [f, read(join(repoDir, f))] as const).filter(([, t]) => t);
  // A pytest config section or conftest.py; else a manifest that lists pytest as a dependency beside a tests/ or test/ directory (the common package with no pytest config).
  const pyDeclares = ["tests", "test"].some((d) => existsSync(join(repoDir, d))) ? [...pyTxt, ["requirements.txt", read(join(repoDir, "requirements.txt"))] as const].find(([, t]) => /^\s*pytest\b|["']pytest\b/m.test(t)) : undefined;
  const pyPytest = pyTxt.find(([f, t]) => f === "pytest.ini" || /\[tool\.pytest|\[tool:pytest\]|\[pytest\]/.test(t)) ?? (existsSync(join(repoDir, "conftest.py")) ? (["conftest.py", ""] as const) : undefined) ?? pyDeclares;
  if (pyTxt.length || pyPytest) {
    const py = [".venv", "venv"].map((d) => join(d, "bin", "python")).find((p) => existsSync(join(repoDir, p))) ?? "python3";
    if (pyPytest) out.push(entry("test", `${py} -m pytest -q`, pyPytest[0]));
    const pp = pyTxt.find(([f]) => f === "pyproject.toml")?.[1] ?? "";
    if (/\[tool\.ruff/.test(pp) || existsSync(join(repoDir, "ruff.toml"))) out.push(entry("lint", "ruff check .", "pyproject.toml"));
    if (/\[tool\.mypy/.test(pp) || existsSync(join(repoDir, "mypy.ini"))) out.push(entry("typecheck", "mypy .", "pyproject.toml"));
  }
  if (existsSync(join(repoDir, "go.mod"))) out.push(entry("test", "go test ./...", "go.mod"), entry("lint", "go vet ./...", "go.mod"), entry("build", "go build ./...", "go.mod"));
  if (existsSync(join(repoDir, "Cargo.toml"))) out.push(entry("test", "cargo test", "Cargo.toml"), entry("lint", "cargo clippy", "Cargo.toml"), entry("build", "cargo build", "Cargo.toml"));
  // CI: only fills a kind no manifest named, and only a plain one-line `run:` command, so a hint never overrides the repo's own scripts.
  for (const wf of workflowFiles(repoDir)) {
    for (const m of read(join(repoDir, wf)).matchAll(/^\s*-?\s*run:\s*([^\n|>][^\n]*)$/gm)) {
      const c = m[1]!.trim().replace(/\s+#.*$/, "");
      const kind = /^(?:npm|pnpm|yarn|bun)(?: run)? (test|lint|typecheck|build)\b/.exec(c)?.[1] as CmdKind | undefined;
      if (kind && !out.some((e) => e.kind === kind) && !/[$&|;`]/.test(c)) out.push(entry(kind, c, wf));
    }
  }
  return out;
}

/** Intake diet: the Project Model answer read straight from the manifests, so a repo whose packages, test and install commands are all
 *  declared costs no discovery session. Packages: the root (when it holds a manifest), every declared JS workspace member, and every other
 *  tracked package manifest outside vendored, fixture, example, docs and test directories. Commands come from discoverCommands (one reader
 *  of manifests); install only from a lockfile (or go.mod), so no install ever mutates a lock; dependsOn only from JS manifests naming another
 *  member (other packages leave it absent: edges unknown). Returns the raw answer for validateAnswer, or null when no package has a test
 *  command, the tree cannot be listed or it holds too many manifests to trust a reading (the model session then decides). A test script that fans out over the
 *  workspace returns { fanOut: <package.json that does> } instead. Never throws. */
const SKIP_PKG_DIR = /^(node_modules|vendor|third_party|test-?data|.*fixtures?|__\w+__|examples?|samples?|templates?|docs?|tests?|e2e|benchmarks?|\..*)$/;
const PKG_MANIFESTS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py"];
const LOCK_INSTALLS: [string, string][] = [["pnpm-lock.yaml", "pnpm install"], ["yarn.lock", "yarn install"], ["bun.lock", "bun install"], ["bun.lockb", "bun install"], ["package-lock.json", "npm install"], ["uv.lock", "uv sync"], ["poetry.lock", "poetry install"], ["Cargo.lock", "cargo fetch"], ["go.mod", "go mod download"]];
const UI_DEPS = ["react-dom", "vue", "svelte", "@angular/core", "next", "nuxt", "solid-js", "preact", "astro"];
const MAX_MODEL_PACKAGES = 200;
const ORCHESTRATOR = /\b(nx|turbo|lerna|run-many|wsrun|ultra)\b|\bpnpm\b[^&|;]*\s(-r|--recursive|--filter|-F)\b|\byarn workspaces\b|\bnpm\b[^&|;]*\s(--workspaces|-ws)\b/;
type RawCmd = { cmd: string; cwd: string; cite: string[] } | null;
/** The test script, followed through up to 3 `<pm> run <script>` hops, fans out over the workspace. */
function fansOut(scripts: Record<string, unknown>): boolean {
  let body = scripts["test"];
  for (let hop = 0; hop < 4 && typeof body === "string"; hop++) {
    if (ORCHESTRATOR.test(body)) return true;
    const next = /^\s*(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)\s*$/.exec(body)?.[1];
    body = next && next !== "test" ? scripts[next] : undefined;
  }
  return false;
}
export function manifestModel(repoDir: string): Record<string, unknown> | { fanOut: string } | null {
  let tracked: string[];
  try { tracked = safeGit(repoDir, ["ls-files", "-z"], { maxBuffer: 256 * 1024 * 1024 }).split("\0").filter(Boolean); } catch { return null; }
  const trackedSet = new Set(tracked), at = (dir: string, f: string): string => (dir === "." ? f : `${dir}/${f}`);
  const json = (dir: string): Record<string, unknown> | null => { try { const j = JSON.parse(read(join(repoDir, dir, "package.json"))) as unknown; return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null; } catch { return null; } };
  const isFile = (rel: string): boolean => trackedSet.has(rel) || (() => { try { return lstatSync(join(repoDir, rel)).isFile(); } catch { return false; } })();
  const wsPats = [...pkgWorkspaces(repoDir), ...pnpmWorkspaces(repoDir)];
  const manifestDirs = [...new Set(tracked.filter((p) => PKG_MANIFESTS.includes(basename(p))).map((p) => dirname(p)))];
  // A member's package.json may be untracked (a generated or ignored manifest that pnpm still reads): any directory holding tracked files qualifies.
  const trackedDirs = new Set<string>(); for (const p of tracked) for (let d = dirname(p); d !== "." && !trackedDirs.has(d); d = dirname(d)) trackedDirs.add(d);
  const members = wsPats.length === 0 ? [] : [...trackedDirs].filter((d) => inWorkspace(wsPats, d) && isFile(at(d, "package.json"))).sort();
  const others = manifestDirs.filter((d) => d !== "." && !members.includes(d) && !d.split("/").some((seg) => SKIP_PKG_DIR.test(seg)));
  const rootHas = MANIFESTS.some((f) => trackedSet.has(f)) || trackedSet.has("setup.py");
  const dirs = [...(rootHas ? ["."] : []), ...members, ...others.sort()];
  if (dirs.length === 0 || dirs.length > MAX_MODEL_PACKAGES) return null;
  const rootLock = LOCK_INSTALLS.find(([f]) => f !== "go.mod" && trackedSet.has(f));
  const nameToRoot = new Map<string, string>();
  for (const d of [".", ...members]) { const n = json(d)?.["name"]; if (typeof n === "string" && n) nameToRoot.set(n, d); }
  const fingerprint = new Set<string>(["pnpm-workspace.yaml"].filter((f) => trackedSet.has(f)));
  const packages = dirs.map((d) => {
    const isMember = members.includes(d), cmds = discoverCommands(join(repoDir, d), isMember ? repoDir : join(repoDir, d));
    const own = [...new Set([...PKG_MANIFESTS, ...MANIFESTS])].map((f) => at(d, f)).filter((f) => trackedSet.has(f) || (isMember && f.endsWith("/package.json") && isFile(f)));
    own.forEach((f) => fingerprint.add(f));
    const cmdOf = (kind: CmdKind): RawCmd => { const c = cmds.find((e) => e.kind === kind); return c ? { cmd: c.cmd, cwd: d, cite: [at(d, c.source)] } : null; };
    const lock = LOCK_INSTALLS.find(([f]) => trackedSet.has(at(d, f)));
    if (lock) fingerprint.add(at(d, lock[0]));
    const install: RawCmd = lock ? { cmd: lock[1], cwd: d, cite: [at(d, lock[0])] } : isMember && rootLock ? { cmd: rootLock[1], cwd: ".", cite: [rootLock[0]] } : pyInstall(repoDir, d, trackedSet, at);
    const pj = json(d), deps = pj ? DEP_KEYS.flatMap((k) => Object.keys((pj[k] as Record<string, unknown> | undefined) ?? {})) : [];
    const uiDep = deps.some((x) => UI_DEPS.includes(x)), scripts = (pj?.["scripts"] ?? {}) as Record<string, unknown>, pm = pkgManager(isMember ? repoDir : join(repoDir, d));
    const boot: RawCmd = uiDep && typeof scripts["dev"] === "string" ? { cmd: `${pm} run dev`, cwd: d, cite: [at(d, "package.json")] } : uiDep && typeof scripts["start"] === "string" ? { cmd: `${pm} start`, cwd: d, cite: [at(d, "package.json")] } : null;
    const js = d === "." || isMember ? (pj ? { dependsOn: [...new Set(deps.map((x) => nameToRoot.get(x)).filter((r): r is string => r !== undefined && r !== d))] } : {}) : {};
    return { name: typeof pj?.["name"] === "string" && pj["name"] ? pj["name"] : d === "." ? basename(resolve(repoDir)) : d, root: d, runner: null, cite: own.length ? own : [cmds[0] ? at(d, cmds[0].source) : at(d, "package.json")],
      commands: { test: cmdOf("test"), lint: cmdOf("lint"), build: cmdOf("build"), start: null }, ui: { present: boot !== null, boot, cite: boot ? boot.cite : [] }, install, ...js };
  });
  // A test script that fans out over the workspace (nx, turbo, lerna, recursive pnpm or yarn) names no one package's suite, so the manifests cannot answer; the caller is told why ({ fanOut }) and decides whether a session is worth it.
  const fan = dirs.find((d) => fansOut((json(d)?.["scripts"] ?? {}) as Record<string, unknown>));
  if (fan !== undefined) return { fanOut: at(fan, "package.json") };
  if (!packages.some((p) => p.commands.test)) return null;
  const wsCite = trackedSet.has("pnpm-workspace.yaml") ? "pnpm-workspace.yaml" : packages[0]!.cite[0]!;
  return { workspaceKind: members.length ? "workspaces" : packages.length > 1 ? "multi-root" : "single", workspaceCite: [wsCite], fingerprintFiles: [...fingerprint].sort(), packages };
}
const DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/** A Python package with no lockfile: its requirements.txt, else an editable install of the project (with its test extra when it declares one), through the interpreter discoverCommands runs pytest with. */
function pyInstall(repoDir: string, d: string, tracked: Set<string>, at: (dir: string, f: string) => string): RawCmd {
  const abs = join(repoDir, d), py = [".venv", "venv"].map((v) => join(v, "bin", "python")).find((p) => existsSync(join(abs, p))) ?? "python3";
  if (tracked.has(at(d, "requirements.txt"))) return { cmd: `${py} -m pip install -r requirements.txt`, cwd: d, cite: [at(d, "requirements.txt")] };
  const pp = tracked.has(at(d, "pyproject.toml")) ? read(join(abs, "pyproject.toml")) : "";
  if (!/^\[project\]/m.test(pp) && !tracked.has(at(d, "setup.py"))) return null;
  const at0 = pp.search(/^\[project\.optional-dependencies\]/m), nl = at0 < 0 ? -1 : pp.indexOf("\n", at0), extras = nl < 0 ? "" : pp.slice(nl + 1).split(/^\[/m)[0]!, extra = ["test", "tests", "testing", "dev"].find((k) => new RegExp(`^\\s*${k}\\s*=`, "m").test(extras));
  return { cmd: `${py} -m pip install -e ${extra ? `'.[${extra}]'` : "."}`, cwd: d, cite: [at(d, /^\[project\]/m.test(pp) ? "pyproject.toml" : "setup.py")] };
}

/** TEN-QUALITY-16: a formatter the repo ITSELF configures. `argv` is the command before the file list; `exts` selects the files it owns; `stdin` is the same formatter reading one
 *  file's text on stdin and printing the formatted text (the base-clean check). Config detection only, never an install. */
export interface RepoFormatter { tool: string; argv: string[]; exts: RegExp; stdin?: (file: string) => string[] }
/** J1 LOKI_E10_FORMAT_RESOLVE (default on, =0 opts out): the formatter binary is resolved the way verify resolves its linter (util/check_result.ts resolveTool: the project venv, then
 *  `uv run`, then PATH), and a file the change modified is formatted only when its BASE blob is already formatter-clean, so the run never reformats lines it did not write.
 *  On the tuning bench the bare `ruff` argv found no binary (the repo's ruff is .venv/bin/ruff, not on PATH), spawnSync failed and nothing was formatted: 11 judge fails were
 *  formatting. =0 restores the bare argv and no base check. */
export const formatResolveEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_FORMAT_RESOLVE"] ?? "").trim());
export function detectFormatters(repoDir: string, env: NodeJS.ProcessEnv = process.env): RepoFormatter[] {
  const out: RepoFormatter[] = [];
  const has = (...fs: string[]): boolean => fs.some((f) => existsSync(join(repoDir, f)));
  const pp = read(join(repoDir, "pyproject.toml")), pj = read(join(repoDir, "package.json"));
  if (/\[tool\.ruff/.test(pp) || has("ruff.toml", ".ruff.toml")) {
    const [cmd, , pre] = formatResolveEnabled(env) ? resolveTool(repoDir, "ruff", "ruff") : ["ruff", "system", [] as string[]];
    out.push({ tool: "ruff", argv: [cmd, ...pre, "format"], exts: /\.pyi?$/, stdin: (f) => [cmd, ...pre, "format", "--stdin-filename", f, "-"] });
  }
  let prettierKey = false;
  try { prettierKey = pj !== "" && "prettier" in (JSON.parse(pj) as object); } catch { /* malformed manifest: no formatter */ }
  const local = join(repoDir, "node_modules", ".bin", "prettier"); // a repo-local binary only: nothing is fetched
  if ((prettierKey || readdirSync(repoDir).some((f) => /^(\.prettierrc(\.[a-z0-9]+)?|prettier\.config\.[cm]?[jt]s)$/.test(f))) && existsSync(local)) out.push({ tool: "prettier", argv: [local, "--write"], exts: /\.(?:[cm]?[jt]sx?|json|css|scss|md|ya?ml|html)$/, stdin: (f) => [local, "--stdin-filepath", f] });
  const biome = join(repoDir, "node_modules", ".bin", "biome"); // same rule: repo-local binary only
  if (has("biome.json", "biome.jsonc") && existsSync(biome)) out.push({ tool: "biome", argv: [biome, "format", "--write"], exts: /\.(?:[cm]?[jt]sx?|json|jsonc|css)$/, stdin: (f) => [biome, "format", `--stdin-file-path=${f}`] });
  if (has("go.mod")) out.push({ tool: "gofmt", argv: ["gofmt", "-w"], exts: /\.go$/, stdin: () => ["gofmt"] });
  if (has("rustfmt.toml", ".rustfmt.toml")) {
    const ed = /^\s*edition\s*=\s*"(\d+)"/m.exec(read(join(repoDir, "Cargo.toml")))?.[1];
    out.push({ tool: "rustfmt", argv: ["rustfmt", ...(ed ? ["--edition", ed] : [])], exts: /\.rs$/, stdin: () => ["rustfmt", ...(ed ? ["--edition", ed] : []), "--emit", "stdout"] });
  }
  return out;
}

/** What the commit stage's formatter pass did, recorded on the commit data so a silent no-op cannot recur unseen: per formatter, the files it formatted and the files it left alone with why. */
export interface FormatRecord { tool: string; cmd: string; formatted: string[]; skipped: { file: string; why: string }[]; error?: string }
/** Runs each detected formatter once over the regular files (no symlinks) it owns. With LOKI_E10_FORMAT_RESOLVE on and a base commit, a file present on base whose base text is not
 *  formatter-clean (the formatter's stdin mode prints something else, or fails) is left alone. A missing binary or nonzero exit formats nothing and is recorded. env must already be token-free. */
export function runFormattersRecord(repoDir: string, files: string[], env: NodeJS.ProcessEnv, baseSha?: string): { formatted: string[]; records: FormatRecord[] } {
  const fmts = detectFormatters(repoDir, env), check = formatResolveEnabled(env) && !!baseSha;
  const mine = fmts.length ? files.filter((f) => { try { return lstatSync(join(repoDir, f)).isFile(); } catch { return false; } }) : [];
  const records: FormatRecord[] = [], formatted: string[] = [];
  for (const fm of fmts) {
    const own = mine.filter((f) => fm.exts.test(f)); if (!own.length) continue;
    const rec: FormatRecord = { tool: fm.tool, cmd: fm.argv.join(" "), formatted: [], skipped: [] };
    const ok = check && fm.stdin ? own.filter((f) => {
      const b = safeGitSpawn(repoDir, ["show", `${baseSha}:${f}`], { encoding: "utf8" }); if (b.status !== 0) return true; // new on this run: nothing on base to protect
      const [c, ...a] = fm.stdin!(f), r = spawnSync(c!, a, { cwd: repoDir, env, input: b.stdout, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      if (r.error || r.status !== 0) { rec.skipped.push({ file: f, why: r.error ? `formatter not runnable (${(r.error as NodeJS.ErrnoException).code ?? "error"})` : `formatter check exited ${r.status} on the base text` }); return false; }
      if (r.stdout !== b.stdout) { rec.skipped.push({ file: f, why: "base text is not formatter-clean" }); return false; }
      return true;
    }) : own;
    if (ok.length) {
      const r = spawnSync(fm.argv[0]!, [...fm.argv.slice(1), ...ok.map((f) => `./${f}`)], { cwd: repoDir, env, stdio: "ignore", timeout: 30000 });
      if (!r.error && r.status === 0) { rec.formatted = ok; formatted.push(...ok); } else rec.error = r.error ? `formatter not runnable: ${fm.argv[0]} (${(r.error as NodeJS.ErrnoException).code ?? "error"})` : `formatter exited ${r.status}`;
    }
    records.push(rec);
  }
  return { formatted, records };
}
/** The formatted files only (the commit stage re-stages them). */
export function runFormatters(repoDir: string, files: string[], env: NodeJS.ProcessEnv, baseSha?: string): string[] { return runFormattersRecord(repoDir, files, env, baseSha).formatted; }

/** Default runner: `sh -c` in repoDir, an explicit scoped env (token-free, no color, no bytecode litter), SIGKILL on timeout. */
export const shellRunner: BaselineRunner = (cmd, cwd, timeoutMs) => {
  const r = spawnSync("sh", ["-c", cmd], { cwd, env: { ...plainTestEnv(), PYTHONDONTWRITEBYTECODE: "1", CI: "1" }, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (r.status === null && r.signal === "SIGKILL");
  return { code: r.status, timedOut, out: stripAnsi(`${r.stdout ?? ""}\n${r.stderr ?? ""}`), missing: r.status === 127 };
};
export const untracked = (repoDir: string): string[] => { try { return safeGit(repoDir, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((l) => l.trim()).filter(Boolean); } catch { return []; } };
/** Removes every untracked file not in `before` (a run's own byproducts; the diff must stay the agent's). */
export const rmNewUntracked = (repoDir: string, before: Set<string>): void => { for (const f of untracked(repoDir)) if (!before.has(f)) rmSync(join(repoDir, f), { force: true, recursive: true }); };

export interface BuildOpts { run?: BaselineRunner; timeoutS?: number; now?: () => Date }
/** Runs `cmd` once in `cwd` on the tree as it is and removes any untracked file the run itself created (the diff must stay the agent's). */
function runOnce(repoDir: string, cmd: string, cwd: string, tmo: number, opts: BuildOpts): { b: CommandProfile["baseline"]; missing: boolean } {
  const before = new Set(untracked(repoDir)), started = Date.now();
  const r = (opts.run ?? shellRunner)(cmd, cwd, tmo * 1000);
  const dur = Math.round((Date.now() - started) / 100) / 10;
  rmNewUntracked(repoDir, before);
  const ids = r.code !== 0 && !r.timedOut ? (failIds(r.out).length ? failIds(r.out) : isExitCodedScript(cmd) && r.code !== null ? [exitCodedId(cmd, r.out, repoDir) ?? []].flat() as string[] : []) : [], missing = r.missing === true;
  const attributable = !r.timedOut && !missing && r.code !== null && (r.code === 0 || ids.length > 0);
  const reason = attributable ? undefined : r.timedOut ? "timed out" : missing ? "command not found" : "failing test ids not parseable, failures cannot be attributed";
  return { b: { ran: true, command: cmd, exit_code: r.code, duration_s: dur, timed_out: r.timedOut, failing_ids: ids, attributable, ...(reason ? { reason } : {}), ...(ids.length ? { failing_errors: Object.fromEntries(errorsById(r.out)) } : {}), ...(!attributable && !r.timedOut && r.code !== 0 && baseRedShapeOn() ? { failing_shape: failureShape(r.out) } : {}), ...(unhandledBlock(r.out).length ? { failing_unhandled: unhandledBlock(r.out) } : {}), zero_tests: r.code === 0 && emptyDiscovery(classifyCheck({ kind: "test", ok: true, out: r.out, ...goRunner(cmd) }), r.out) }, missing };
}
/** A suite red at base is run a second time (only when the first pass fit FLAKE_PROBE_MAX_S and did not time out): an id that fails on one pass and not the other is flaky,
 *  recorded as flaky_ids, so a head run is not blamed for an id that flips without any change (tanstack-query: 2054 to 2183 red ids, up to 14 new flaky ids per pass). */
export const FLAKE_PROBE_MAX_S = 120;
/** A baseline with this many failing ids is "suite red at base": the comparison is per id and its pass never counts as proof. */
export const MASSIVE_RED_IDS = 500;
function runProbed(repoDir: string, cmd: string, cwd: string, tmo: number, opts: BuildOpts): { b: CommandProfile["baseline"]; missing: boolean } {
  const first = runOnce(repoDir, cmd, cwd, tmo, opts), b = first.b;
  if (!b.failing_ids.length) return { b: { ...b, flaky_probe: "done" }, missing: first.missing };
  if (b.timed_out || first.missing || (b.duration_s ?? 0) > FLAKE_PROBE_MAX_S) return { b: { ...b, flaky_probe: `skipped: first pass ${b.duration_s ?? "?"}s` }, missing: first.missing };
  const second = runOnce(repoDir, cmd, cwd, tmo, opts).b;
  if (second.timed_out || second.exit_code === null) return { b: { ...b, flaky_probe: "skipped: second pass did not finish" }, missing: first.missing };
  const one = new Set(b.failing_ids), two = new Set(second.failing_ids), flaky = [...one].filter((i) => !two.has(i)).concat([...two].filter((i) => !one.has(i)));
  return { b: { ...b, flaky_probe: "done", ...(flaky.length ? { flaky_ids: flaky, failing_errors: { ...(second.failing_errors ?? {}), ...(b.failing_errors ?? {}) } } : {}) }, missing: first.missing };
}
/** Runs the first test command once and records it on the command. */
export function runBaseline(repoDir: string, commands: ProfileCommand[], opts: BuildOpts = {}): CommandProfile["baseline"] {
  const t = commands.find((c) => c.kind === "test");
  if (!t) return { ran: false, command: null, exit_code: null, duration_s: null, timed_out: false, failing_ids: [], attributable: false, reason: "no test command discovered" };
  const tmo = opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S, { b, missing } = runProbed(repoDir, t.cmd, repoDir, tmo, opts);
  t.validated = !b.timed_out && !missing && b.exit_code !== null; t.exit_code = b.exit_code; t.duration_s = b.duration_s; t.failing_ids = b.failing_ids;
  if (b.timed_out) t.note = `timed out after ${tmo}s; no baseline`; else if (missing) t.note = "command not found";
  return b;
}
const normCmd = (s: string): string => s.replace(/\s+--silent\b/, "").trim().replace(/^\(cd \.\s+&&\s+(.+)\)$/, "$1"); // a root package suite is spelled "(cd . && X)" by package_suite.ts but the baseline ran plain "X": same command, never "not the full suite command"
/** SPEED-BASE-ALIAS (LOKI_BASELINE_SCRIPT_ALIAS=0 opts out): `npm test`, `pnpm test` and `yarn test` (with or without `run`) at the repo root run the same package.json script, so one base
 *  run of it speaks for the others. Only when the root package.json declares that script and no pre/post hook for it (npm runs pretest and posttest, pnpm and yarn berry do not), so the
 *  commands run exactly the same thing. A tanstack-query baseline ran `pnpm test` and then `npm test --silent`, twice each (51 s), for one script. */
const PM_SCRIPT = /^(?:npm|pnpm|yarn)(?:\s+run)?\s+([\w:.-]+)$/;
export function sameRootScript(repoDir: string, a: string, b: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LOKI_BASELINE_SCRIPT_ALIAS === "0") return false;
  const ma = PM_SCRIPT.exec(normCmd(a)), mb = PM_SCRIPT.exec(normCmd(b)), name = ma?.[1];
  if (!name || name !== mb?.[1]) return false;
  try {
    const scripts = (JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return typeof scripts[name] === "string" && scripts[`pre${name}`] === undefined && scripts[`post${name}`] === undefined;
  } catch { return false; }
}
/** The base entry for `cmd`: the entry that ran exactly this command (normCmd) first, else the root baseline when it ran the same root script (sameRootScript). `ranOnly` skips entries that never ran. */
function baseFor(repoDir: string, p: CommandProfile, cmd: string, ranOnly: boolean): CommandProfile["baseline"] | undefined {
  const all = [p.baseline, ...(p.suites ?? [])].filter((b) => !ranOnly || b.ran);
  return all.find((b) => normCmd(b.command ?? "") === normCmd(cmd)) ?? ((!ranOnly || p.baseline.ran) && sameRootScript(repoDir, p.baseline.command ?? "", cmd) ? p.baseline : undefined);
}
export const SUITE_BASELINE_BUDGET_S = 300;
/** FC-BASELINE-PER-PACKAGE: a baseline per full-suite command verify will run (`specs`: package_suite.ts fullSuiteSpecs, the one source), added to the
 *  profile ensureProfile wrote for this HEAD. An entry for the same command is reused unless `rerun` (a dependency install succeeded
 *  since, so a baseline measured before it is stale: the main baseline and every entry are re-run, attributable or not). A root command the main baseline already ran is not run twice. One shared
 *  budget; a suite past it is recorded not run, so nothing it fails is excused (fail-closed). Never throws: null when there is no current profile. */
export function baselineSuites(repoDir: string, specs: { name: string; cmd: string; cwd: string; run: string }[], opts: BuildOpts & { rerun?: boolean; budgetS?: number; deadlineMs?: number } = {}): CommandProfile | null {
  try {
    const p = loadProfile(repoDir);
    if (!p || p.revision !== headOf(repoDir)) return null;
    const dl = (): number => (opts.deadlineMs === undefined ? Infinity : Math.floor((opts.deadlineMs - Date.now()) / 1000)); // R3 intake cap: what is left of intake's baseline budget
    if (opts.rerun && p.baseline.ran && dl() >= 1) p.baseline = runBaseline(repoDir, p.commands, opts.deadlineMs === undefined ? opts : { ...opts, timeoutS: Math.max(1, Math.min(opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S, dl())) });
    let left = Math.min(opts.budgetS ?? SUITE_BASELINE_BUDGET_S, dl());
    const old = p.suites ?? [];
    const rootSpeaks = (run: string): boolean => normCmd(run) === normCmd(p.baseline.command ?? "") || (p.baseline.ran && p.baseline.attributable && !p.baseline.timed_out && sameRootScript(repoDir, p.baseline.command ?? "", run)); // an alias is reused only when its base run is complete and attributable; otherwise the suite is measured under its own command
    p.suites = specs.filter((s) => s.cwd !== "." || !rootSpeaks(s.run)).map((s) => {
      const prev = old.find((o) => o.command === s.cmd);
      if (prev?.ran && !opts.rerun && !cutShort(prev, Math.min(opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S, Math.floor(left))) && (prev.failing_ids.length === 0 || (prev.failing_errors && prev.flaky_probe !== undefined))) return prev; // an entry recorded before failing_errors existed is measured again
      const tmo = Math.min(opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S, Math.floor(left)), t0 = Date.now();
      if (tmo < 1) return { name: s.name, ran: false, command: s.cmd, exit_code: null, duration_s: null, timed_out: false, failing_ids: [], attributable: false, reason: "baseline budget used up" };
      const { b } = runProbed(repoDir, s.run, join(repoDir, s.cwd), tmo, opts);
      left -= (Date.now() - t0) / 1000;
      return { name: s.name, ...b, command: s.cmd };
    });
    save(repoDir, p);
    return p;
  } catch { return null; }
}

/** True only when the same full-suite command ran on exactly this base commit, exited 0 and discovered no tests (empty discovery, no skips), and `cls` is the head's empty discovery too: the suite was empty before the change as well, so it says nothing about the change. Anything else (no profile, a package directory with no suites entry, other revision, unmatched command, base executed or skipped tests) is false, so the head's 0-test result stays not_run. */
export function suiteEmptyOnBase(repoDir: string, baseSha: string | undefined, line: string, name: string, cls: Classified, out: string, cwd = "."): boolean {
  const p = baseSha ? loadProfile(repoDir) : null;
  if (!p || p.revision !== baseSha || !emptyDiscovery(cls, out)) return false;
  const e = p.suites?.find((x) => x.command === name) ?? (cwd === "." && (normCmd(p.baseline.command ?? "") === normCmd(line) || sameRootScript(repoDir, p.baseline.command ?? "", line)) ? p.baseline : undefined); // the root baseline speaks only for the repo root, never for a package directory
  return e?.ran === true && e.exit_code === 0 && e.zero_tests === true;
}

/** Keeps the intake baseline in the run directory (<runDir>/baseline.json): per command, exit code, duration, whether it was cut off, failing ids and flaky ids, so a receipt and later analysis read what base measured. Never throws. */
export function writeBaselineRecord(repoDir: string, runDir: string): void {
  try {
    const p = loadProfile(repoDir); if (!p) return;
    const row = (b: CommandProfile["baseline"] & { name?: string }) => ({ ...(b.name ? { name: b.name } : {}), command: b.command, ran: b.ran, exit_code: b.exit_code, duration_s: b.duration_s, cut_off: b.timed_out || b.reason === "baseline budget used up", ...(b.reason ? { reason: b.reason } : {}), attributable: b.attributable, failing_count: b.failing_ids.length, failing_ids: b.failing_ids, flaky_ids: b.flaky_ids ?? [], flaky_probe: b.flaky_probe ?? null });
    mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, "baseline.json"), JSON.stringify({ revision: p.revision, baseline: row(p.baseline), suites: (p.suites ?? []).map(row) }, null, 2) + "\n");
  } catch { /* the record is evidence, never a reason to stop a run */ }
}

export function loadProfile(repoDir: string): CommandProfile | null {
  try { const p = JSON.parse(readFileSync(commandProfilePath(repoDir), "utf8")) as CommandProfile; return p?.version === 1 && Array.isArray(p.commands) && p.baseline ? p : null; } catch { return null; }
}
function save(repoDir: string, p: CommandProfile): void {
  const path = commandProfilePath(repoDir), tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(join(repoDir, ".loki", "state"), { recursive: true });
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n"); renameSync(tmp, path);
}
const headOf = (repoDir: string): string => { try { return safeGit(repoDir, ["rev-parse", "HEAD"]).trim(); } catch { return ""; } };

/** The one entry point (intake). Same manifest hash and HEAD: reuse. Same hash, new HEAD: keep the commands, re-run only the baseline. New hash: rediscover and re-baseline. */
export function ensureProfile(repoDir: string, opts: BuildOpts = {}): { profile: CommandProfile; reused: boolean } | null {
  try {
    const hash = manifestHash(repoDir), rev = headOf(repoDir), old = loadProfile(repoDir);
    if (old && old.manifest_hash === hash && old.revision === rev && !cutShort(old.baseline, opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S) && (old.baseline.failing_ids.length === 0 || (old.baseline.failing_errors && old.baseline.flaky_probe !== undefined))) return { profile: old, reused: true };
    const commands = old && old.manifest_hash === hash ? old.commands.map((c) => ({ ...c, ...(c.kind === "test" ? { validated: null, exit_code: null, duration_s: null, failing_ids: [] } : {}) })) : discoverCommands(repoDir);
    const profile: CommandProfile = { version: 1, revision: rev, manifest_hash: hash, created_at: (opts.now?.() ?? new Date()).toISOString(), commands, baseline: runBaseline(repoDir, commands, opts) };
    save(repoDir, profile);
    return { profile, reused: false };
  } catch { return null; }
}

/** Failing checks split by the baseline. A check is pre-existing only when the profile ran on exactly this base commit, the baseline was attributable,
 *  `eligible` (the caller: untouched, non-target test) and EVERY failing id of the check is in the baseline (one new id makes it introduced).
 *  A check without parsed ids is introduced: unknown never excuses a failure. FireLater#21: `suite` names the full-suite check of the package that
 *  owns the test (the caller's FC-BASELINE-PER-PACKAGE `suites` entry); its ids are that package's baseline, so a frontend page test in a repo whose
 *  root command runs nothing is compared with the frontend suite's base failures. No suite, or one that did not run attributably: the root baseline. */
export interface Attribution { preExistingChecks: string[]; preExistingIds: string[]; introducedChecks: string[]; line: string | null }
export function attribute(repoDir: string, baseSha: string, failing: { name: string; ids?: string[]; eligible: boolean; suite?: string }[]): Attribution {
  const p = loadProfile(repoDir), none: Attribution = { preExistingChecks: [], preExistingIds: [], introducedChecks: failing.map((f) => f.name), line: null };
  if (!p || p.revision !== baseSha || failing.length === 0) return none;
  const root = p.baseline.attributable ? p.baseline.failing_ids : [], own = (name?: string): string[] => { const s = name ? p.suites?.find((x) => x.name === name && x.ran && x.attributable) : undefined; return s ? s.failing_ids : root; };
  const rows = failing.map((f) => ({ ...f, base: new Set(own(f.suite)) })), known = new Set(rows.flatMap((r) => [...r.base]));
  if (known.size === 0) return none;
  return split(rows, known.size);
}
/** Each failing check against its own baseline id set; `known` is the number of baseline failures the line reports. */
function split(failing: { name: string; ids?: string[]; eligible: boolean; base: Set<string> }[], known: number): Attribution {
  const unparsed = failing.filter((f) => !f.ids?.length && f.base.size > 0).length; // FC-FULLSUITE-ANSI-IDS: a failing check with no parsed ids against an attributable baseline
  const pre = failing.filter((f) => f.eligible && f.ids?.length && comparableIds(f.ids).every((i) => f.base.has(i)));
  const introduced = failing.filter((f) => !pre.includes(f)).map((f) => f.name);
  if (pre.length === 0) return { preExistingChecks: [], preExistingIds: [], introducedChecks: introduced, line: `baseline: ${known} known failure(s) before this run; ${unparsed ? `head failure ids unparseable for ${unparsed} failing check(s), cannot compare` : "none of the failing checks match them"}, ${introduced.length} introduced (blocking)` };
  return { preExistingChecks: pre.map((f) => f.name), preExistingIds: pre.flatMap((f) => f.ids ?? []), introducedChecks: introduced,
    line: `baseline: ${pre.length} pre-existing failing check(s) (not blocking), ${introduced.length} introduced${introduced.length ? " (blocking)" : ""}` };
}

/** The nearest go.mod at or above `targetDir` (never above `repoDir`): its directory and module path. `read` returns a file's text or undefined; pure otherwise. */
function goModuleOf(read: (file: string) => string | undefined, repoDir: string, targetDir: string): { dir: string; path: string } | undefined {
  for (let d = targetDir; d.startsWith(repoDir); d = dirname(d)) {
    const m = /^module\s+(\S+)/m.exec(read(join(d, "go.mod")) ?? "");
    if (m) return { dir: d, path: m[1]! };
    if (d === repoDir || d === dirname(d)) break;
  }
  return undefined;
}
/** The Go import path of `targetDir`: the module path, then the relative directory appended. */
export function goPackagePath(read: (file: string) => string | undefined, repoDir: string, targetDir: string): string | undefined {
  const m = goModuleOf(read, repoDir, targetDir); if (!m) return undefined;
  const rel = relative(m.dir, targetDir); return rel ? `${m.path}/${rel}` : m.path;
}

/** FC-GO-PACKAGE-ID-CHANGED-FILE: a go id is "pkg" (package-only fail, build failure) or "pkg::Test", pkg an import path, so the
 *  changed-file substring guard can never match it. True when a changed .go file sits in the id's package directory: the import path
 *  resolved through the go.mod module path, else its trailing segments against the file's dirname. */
function goIdTouched(repoDir: string, id: string, changed: string[]): boolean {
  const pkg = id.split("::")[0] ?? "";
  const modOf = (dir: string): string | null => {
    try { return /^module\s+(\S+)/m.exec(readFileSync(join(repoDir, dir, "go.mod"), "utf8"))?.[1] ?? null; } catch { return null; }
  };
  return changed.some((f) => {
    if (/(?:^|\/)go\.work(?:\.sum)?$/.test(f)) return true;
    const isMod = /(?:^|\/)go\.(?:mod|sum)$/.test(f);
    if (!f.endsWith(".go") && !isMod) return false;
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    // nearest enclosing go.mod (nested modules, go.work): the package path is that module path plus the file's directory below it
    const parts = dir === "." ? [] : dir.split("/");
    for (let n = parts.length; n >= 0; n--) {
      const modDir = parts.slice(0, n).join("/") || ".", mod = modOf(modDir);
      if (mod) { if (isMod) return pkg === mod || pkg.startsWith(mod + "/"); const rel = parts.slice(n).join("/"); return pkg === (rel ? `${mod}/${rel}` : mod); }
    }
    return dir !== "." && (pkg === dir || pkg.endsWith("/" + dir));
  });
}

/** FC-CARGO-ID-CHANGED-CRATE: a cargo test id is a module path ("tests::adds") with no crate or file in it, so no changed-file guard can match it.
 *  A failing full-suite check is never excused when the diff touches Rust source or a Cargo manifest, whatever its command (a make target or a package-manager script can wrap cargo), since the failing test may live in the edited crate. */
function cargoTouched(changed: string[]): boolean {
  return changed.some((f) => /\.rs$|(?:^|\/)(?:Cargo\.(?:toml|lock)|build\.rs)$/.test(f));
}

/** REPOMEM for the RISKTIER full suite: the same `attribute`, fed the ids the REAL run's check carries (`ids`, from failIds). Nothing is re-run.
 *  Fail-closed, per command (FC-BASELINE-PER-PACKAGE): each failing check is compared only with the baseline that ran its own command (the main one
 *  or a `suites` entry); a check no baseline ran makes the ids not comparable and nothing is excused (the reason is returned in `line`), an
 *  unattributable baseline excuses nothing, ids must be present and complete (failIds gives [] on partial extraction), and an id the targeted checks
 *  already failed (`blocked`) or one naming a changed file is never excused. */
/** FireLater#21 (review): ids alone never excuse a full suite. Each failing id must fail on base with the same error lines (sameErrors against the baseline's
 *  failing_errors); a suite whose output or baseline has no error lines for an id (a baseline recorded before failing_errors, go, cargo) is not excused. */
type FullCheck = { name: string; cmd: string; result: string; ids?: string[]; errors?: Record<string, string[]>; unhandled?: string[]; exit?: number | null; shape?: string };
/** BASE-RED-SHAPE: the failing full-suite checks whose base run, on exactly this base commit and the same command, was red and unattributable (no
 *  parseable ids; not cut off) and failed in the identical kind on head: the same exit code, no parseable ids on head either, and the same output
 *  shape (failureShape). A new failing test, a different message or count, or a changed exit code gives a different kind, so nothing the change broke
 *  is excused. Never for a check the caller already lists in `blocked` ids, and off with LOKI_E10_BASE_RED_SHAPE=0. */
export function sameUnattributableRed(repoDir: string, baseSha: string, full: FullCheck[]): string[] {
  if (!baseRedShapeOn()) return [];
  const p = loadProfile(repoDir); if (!p || p.revision !== baseSha) return [];
  return full.filter((c) => {
    if (c.result !== "fail" || (c.ids ?? []).length > 0 || !c.shape || c.exit === undefined) return false;
    const b = baseFor(repoDir, p, c.cmd, true);
    return !!b && b.ran && !b.attributable && !b.timed_out && b.reason !== "baseline budget used up" && b.failing_ids.length === 0 && !!b.failing_shape && b.failing_shape === c.shape && b.exit_code === c.exit;
  }).map((c) => c.name);
}
export const SAME_RED_NOTE = "excused as red on base in the identical kind (same command, same exit code, the same unparseable output shape; no failing id could be compared)";
export function attributeFullSuite(repoDir: string, baseSha: string, full: FullCheck[], blocked: string[], changed: string[], symbols: readonly string[] = []): Attribution {
  const same = sameUnattributableRed(repoDir, baseSha, full);
  const res = attributeFullSuiteById(repoDir, baseSha, same.length ? full.filter((c) => !same.includes(c.name)) : full, blocked, changed, symbols);
  if (!same.length) return res;
  const note = full.filter((c) => same.includes(c.name)).map((c) => `NOT PROVEN: "${c.cmd}" was ${SAME_RED_NOTE}`).join("; ");
  return { ...res, preExistingChecks: [...res.preExistingChecks, ...same], introducedChecks: res.introducedChecks.filter((n) => !same.includes(n)), line: [res.line, note].filter(Boolean).join("; ") };
}
function attributeFullSuiteById(repoDir: string, baseSha: string, full: FullCheck[], blocked: string[], changed: string[], symbols: readonly string[] = []): Attribution {
  const bad = full.filter((c) => c.result === "fail"), none: Attribution = { preExistingChecks: [], preExistingIds: [], introducedChecks: bad.map((c) => c.name), line: null }, p = loadProfile(repoDir);
  if (!bad.length || !p || p.revision !== baseSha) return none;
  const runs = [p.baseline, ...(p.suites ?? [])].filter((b) => b.ran), of = (cmd: string) => baseFor(repoDir, p, cmd, true);
  // A base run that was cut off (its time or the shared baseline budget ran out) says nothing about which failures were already there: record it, never blame silently.
  const cut = bad.filter((c) => { const b = baseFor(repoDir, p, c.cmd, false); return !!b && (b.timed_out || b.reason === "baseline budget used up"); });
  if (cut.length) return { ...none, line: `NOT PROVEN: base run incomplete for ${cut.map((c) => `"${c.cmd}"`).join(", ")} (cut off on the original code), so its failures are not excusable` };
  const ids = (cmd: string): string[] => { const b = of(cmd); return b?.attributable ? [...b.failing_ids, ...(b.flaky_ids ?? [])] : []; }, miss = bad.find((c) => !of(c.cmd));
  if (miss) return { ...none, line: `baseline: ran ${runs.map((b) => `"${b.command}"`).join(", ") || "nothing"}, not the full suite command "${miss.cmd}", ids not comparable, full suite failures not excused` };
  const massive = (cmd: string): boolean => (of(cmd)?.failing_ids.length ?? 0) >= MASSIVE_RED_IDS, known = new Set(bad.flatMap((c) => ids(c.cmd))), block = new Set(blocked), sameAsBase = (c: (typeof bad)[number]): boolean => { const b = of(c.cmd), be = b?.failing_errors, hu = c.unhandled ?? [], bu = b?.failing_unhandled ?? []; /* every id, flaky or not, must repeat its stored base error (a flaky id keeps the error of the pass it failed on), at the same multiplicity, whatever the suite size */ return !!be && !!c.errors && hu.length === bu.length && hu.every((x, n) => x === bu[n]) /* an unhandled-errors block names no id: it must repeat on base */ && sameErrors(new Map(Object.entries(c.errors)), be, comparableIds(c.ids ?? [])); },
    /* fl24: the second chance when the text differs: the same unhandled block, the same error shapes (noise only) and no head error line naming a changed file or symbol (noiseOnlyErrors); listed NOT PROVEN below */ quietAsBase = (c: (typeof bad)[number]): boolean => { const be = of(c.cmd)?.failing_errors, hu = c.unhandled ?? [], bu = of(c.cmd)?.failing_unhandled ?? []; return !!be && !!c.errors && hu.length === bu.length && hu.every((x, n) => x === bu[n]) && noiseOnlyErrors(c.errors, be, comparableIds(c.ids ?? []), changed, symbols); },
    /* a flaky id, or any id of a suite red at base, whose head error text names a file the change edited is the change's own failure, whatever the id */ errNamesChanged = (c: (typeof bad)[number]): boolean => { const fl = new Set(of(c.cmd)?.flaky_ids ?? []), all = massive(c.cmd), keys = Object.keys(c.errors ?? {}).filter((k) => all || [...fl].some((i) => k === i || k.endsWith(` > ${i}`))); return keys.some((k) => (c.errors?.[k] ?? []).some((l) => changed.some((f) => l.includes(f)))); };
  if (known.size === 0) return none;
  const unproven = [...new Set(bad.flatMap((c) => c.ids ?? []).filter((i) => !i.includes("::") && goIdTouched(repoDir, i, changed)))];
  const res = split(bad.map((c) => ({ name: c.name, ...(c.ids ? { ids: c.ids } : {}), eligible: !cargoTouched(changed) && (sameAsBase(c) || quietAsBase(c)) && !errNamesChanged(c) && (c.ids ?? []).every((i) => !block.has(i) && !changed.some((f) => idNamesFile(i, f)) && !goIdTouched(repoDir, i, changed)), base: new Set(ids(c.cmd)) })), known.size);
  const rust = (cargoTouched(changed) ? bad : []).map((c) => `NOT PROVEN: ${c.name} may run cargo tests and the diff edits Rust source or a manifest; cargo test ids carry no crate path, so a failure cannot be shown pre-existing`);
  const red = res.preExistingChecks.length ? bad.filter((c) => res.preExistingChecks.includes(c.name) && massive(c.cmd)) : [], redLine = red.map((c) => `NOT PROVEN: suite red at base (${of(c.cmd)!.failing_ids.length} failing ids) for "${c.cmd}": it is compared per id, never blocks and proves nothing about this change`).join("; ");
  if (redLine) res.line = [res.line, redLine].filter(Boolean).join("; ");
  const flakyOnly = bad.filter((c) => res.preExistingChecks.includes(c.name)).flatMap((c) => { const b = of(c.cmd), base = new Set(b?.failing_ids ?? []), hit = comparableIds(c.ids ?? []).filter((i) => (b?.flaky_ids ?? []).includes(i) && !base.has(i)); return hit.length ? [`NOT PROVEN: "${c.cmd}" was excused with ${hit.length} id(s) that fail on only some base passes (flaky), e.g. ${hit[0]}; the change was not shown to leave them alone`] : []; }).join("; ");
  if (flakyOnly) res.line = [res.line, flakyOnly].filter(Boolean).join("; ");
  const quiet = bad.filter((c) => res.preExistingChecks.includes(c.name) && !sameAsBase(c)).map((c) => `NOT PROVEN: "${c.cmd}" was excused as red on base although its error text differs from base (by noise only: the same error shapes); no changed file or symbol appears in any failure`).join("; ");
  if (quiet) res.line = [res.line, quiet].filter(Boolean).join("; ");
  if (!unproven.length && !rust.length) return res;
  const np = [...unproven.map((u) => `NOT PROVEN: package ${u} did not build on base or head; its tests ran on neither`), ...rust].join("; ");
  return { ...res, line: [res.line, np].filter(Boolean).join("; ") };
}

/** One line per failing full-suite check that attributeFullSuite did not excuse, saying which rule kept it blocking (so a receipt never shows an unexplained red suite).
 *  Same inputs and the same profile as attributeFullSuite; `excused` is its preExistingChecks. */
export function whyFullSuiteNotExcused(repoDir: string, baseSha: string, full: FullCheck[], changed: string[], excused: string[], blocked: readonly string[] = []): string[] {
  const p = loadProfile(repoDir), out: string[] = [];
  for (const c of full.filter((x) => x.result === "fail" && !excused.includes(x.name))) {
    const why = (r: string): void => { out.push(`not excused: ${c.name} (\`${c.cmd}\`): ${r}`); }, b = p ? baseFor(repoDir, p, c.cmd, true) : undefined, b0 = p ? baseFor(repoDir, p, c.cmd, false) : undefined, cutB = b0 && (b0.timed_out || b0.reason === "baseline budget used up") ? b0 : undefined;
    if (!p) { why("no baseline was recorded"); continue; }
    if (p.revision !== baseSha) { why("the baseline was measured on another commit"); continue; }
    if (cutB) { why("base run incomplete (cut off on the original code)"); continue; }
    if (!b) { why("the baseline did not run this command"); continue; }
    if (!b.attributable) { why(`the base run is not attributable (${b.reason ?? "no failing ids parsed"})${baseRedShapeOn() ? `; BASE-RED-SHAPE: exit base ${b.exit_code} head ${c.exit ?? "unknown"}, shape ${!b.failing_shape ? "not recorded on base" : !c.shape ? "absent on head (ids parsed)" : b.failing_shape === c.shape ? "same" : "differs"}` : ""}`); continue; } // BASE-RED-SHAPE marker: why the identical-kind rule did not excuse it
    if (!c.ids?.length) { why("its failing ids could not be parsed from the output, so nothing can be compared"); continue; }
    if (cargoTouched(changed)) { why("the diff edits Rust source or a manifest and cargo ids carry no crate path"); continue; }
    const known = new Set([...b.failing_ids, ...(b.flaky_ids ?? [])]), fresh = comparableIds(c.ids).filter((i) => !known.has(i)), inChanged = c.ids.filter((i) => changed.some((f) => i.includes(f)) || goIdTouched(repoDir, i, changed));
    if (inChanged.length) { why(`${inChanged.length} failing id(s) name a changed file (first: ${inChanged[0]})`); continue; }
    if (fresh.length) { why(`${fresh.length} failing id(s) were not red on base (first: ${fresh[0]})`); continue; }
    // fl24: FireLater#24 read "error text differs" when the text was identical: 146 of its ids also failed in 22 targeted checks that were not excused.
    const held = new Set(blocked), inBlocked = c.ids.filter((i) => held.has(i));
    if (inBlocked.length) { why(`${inBlocked.length} failing id(s) also fail in a targeted check that was not excused (first: ${inBlocked[0]})`); continue; }
    why("every failing id is red on base but the error text differs from base and a failure names a changed file or symbol (or an unhandled-errors block differs)");
  }
  return out;
}

/** fl24: the still-failing checks whose every comparable id is red on base by id alone, the harness's evidence for a fix round that stops with
 *  "these failures pre-exist on base" (machine.ts). An id counts red on base when this run's own base rerun showed it (`knownRed`, verify's
 *  subtractBase) or the intake profile on this exact base commit lists it: the check's package suite (`suite`), the root baseline, or the
 *  baseline of the check's own command (`cmd`, a full suite). A check is left out when the caller marks it ineligible (a target, Wall or
 *  holdout check, or a test file the run touched), when an id names a changed file, when the diff edits Rust source or a manifest, or when any
 *  of its head error lines names a changed file or symbol, or when this run's base rerun printed errors of another shape (`shapeDiffers`: the change
 *  altered the failure). Text is otherwise not compared (a profile suite's reporter wording differs from a per-file run's): evidence for the claim only. */
export function baseRedById(repoDir: string, baseSha: string, failing: { name: string; cmd?: string; ids?: string[]; errors?: Map<string, string[]> | Record<string, string[]>; suite?: string; eligible: boolean }[], knownRed: readonly string[], changed: string[], symbols: readonly string[] = [], shapeDiffers: readonly string[] = []): string[] {
  const p = loadProfile(repoDir), names = lineNamesChange(changed, symbols);
  if (cargoTouched(changed)) return [];
  const idsOf = (b: CommandProfile["baseline"] | undefined): string[] => (b && b.ran && b.attributable && !b.timed_out && b.reason !== "baseline budget used up" ? [...b.failing_ids, ...(b.flaky_ids ?? [])] : []);
  return failing.filter((f) => {
    const ids = comparableIds(f.ids ?? []);
    if (!f.eligible || shapeDiffers.includes(f.name) || ids.length === 0 || ids.some((i) => changed.some((c) => idNamesFile(i, c)) || goIdTouched(repoDir, i, changed))) return false;
    const lines = f.errors instanceof Map ? [...f.errors.values()].flat() : Object.values(f.errors ?? {}).flat();
    if (lines.some(names)) return false;
    if (knownRed.includes(f.name)) return true;
    if (!p || p.revision !== baseSha) return false;
    const base = new Set([...idsOf(p.baseline), ...idsOf(f.suite ? p.suites?.find((s) => s.name === f.suite) : undefined), ...idsOf(f.cmd ? baseFor(repoDir, p, f.cmd, true) : undefined)]);
    return ids.every((i) => base.has(i));
  }).map((f) => f.name);
}

/** Static-diagnostic attribution (TEN-QUALITY-02): lint output of head vs base as multisets keyed path/code/message, line and column dropped so shifts do not count.
 *  preExisting only when every head diagnostic key appears in base at the same or a higher count. Fail-closed (introduced): unknown tool, unparseable head or base
 *  output, an empty parse with a non-zero or unknown (null, the default) exit, a summary count >0 with nothing parsed, or a missing base output (file new on head). */
export type StaticTool = "ruff" | "shellcheck" | "eslint";
export interface StaticAttribution { preExisting: boolean; introduced: string[]; reason: string }
const STATIC_DIAG: Record<StaticTool, RegExp> = {
  ruff: /^(.+?):\d+:\d+: ([A-Z]+\d+) (?:\[\*\] )?(.*)$/,
  shellcheck: /^(.+?):\d+:\d+: (?:error|warning|note|info|style): (.*) \[(SC\d+)\]$/,
  eslint: /^(.+?):\d+:\d+: (.*) \[(?:Error|Warning)\/([^\]]*)\]$/,
};
const STATIC_NOISE = /^(?:Found \d+ errors?\.?|\[\*\] .*|All checks passed!|No fixes available.*|\d+ problems?)$/;
const STATIC_SUMMARY = /^\s*(?:Found ([1-9]\d*) errors?|([1-9]\d*) problems?)/m;
function parseStatic(tool: StaticTool, out: string): Map<string, number> | null {
  const re = STATIC_DIAG[tool], m = new Map<string, number>();
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line || STATIC_NOISE.test(line)) continue;
    const g = re.exec(line);
    if (!g) return null;
    const [path, code, msg] = tool === "ruff" ? [g[1]!, g[2]!, g[3]!] : [g[1]!, g[3]!, g[2]!];
    const k = `${path}\u0000${code}\u0000${msg}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}
export function attributeStatic(tool: string, headOut: string, baseOut: string | null, headExit: number | null = null): StaticAttribution {
  const bad = (reason: string): StaticAttribution => ({ preExisting: false, introduced: [], reason });
  if (tool !== "ruff" && tool !== "shellcheck" && tool !== "eslint") return bad(`unknown tool ${tool}`);
  const head = parseStatic(tool, headOut);
  if (!head) return bad("unparseable head output");
  if (head.size === 0 && headExit !== 0) return bad("no diagnostics parsed but non-zero exit");
  if (head.size === 0 && STATIC_SUMMARY.test(headOut)) return bad("summary reports problems but no diagnostics parsed");
  if (baseOut === null) return bad("no base output (file new on head)");
  const base = parseStatic(tool, baseOut);
  if (!base) return bad("unparseable base output");
  const introduced: string[] = [];
  for (const [k, n] of head) if (n > (base.get(k) ?? 0)) introduced.push(k.split("\u0000").join(" "));
  return { preExisting: introduced.length === 0, introduced, reason: introduced.length ? `${introduced.length} new diagnostic(s)` : "all diagnostics present on base" };
}

/** TEN-QUALITY-03: is every static diagnostic of `files` already present on base? One head run over all files, one stdin run per file on its base content
 *  (`io.base` returns null for a file absent from base). `prefix` is the tool's own leading args (ruff "check", eslint "eslint"). Fail-closed: a run that does
 *  not execute, or a file with head diagnostics and no base content (new on head), is never excused. */
export async function staticPreExisting(tool: StaticTool, prefix: string[], files: string[], io: { run(args: string[], stdin?: string): Promise<{ out: string } | null>; base(f: string): string | null }): Promise<boolean> {
  const fmt = tool === "ruff" ? ["--output-format=concise"] : tool === "shellcheck" ? ["-f", "gcc"] : ["-f", "unix"];
  const head = await io.run([...prefix, ...fmt, ...files]);
  if (!head) return false;
  let baseOut = "";
  for (const f of files) {
    const content = io.base(f);
    if (content === null) { if (head.out.includes(`${f}:`)) return false; continue; }
    const stdin = tool === "ruff" ? ["--stdin-filename", f, "-"] : tool === "eslint" ? ["--stdin", "--stdin-filename", f] : ["-"];
    const r = await io.run([...prefix, ...fmt, ...stdin], content);
    if (!r) return false;
    baseOut += (tool === "shellcheck" ? r.out.replace(/^-:/gm, `${f}:`) : r.out) + "\n";
  }
  return attributeStatic(tool, head.out, baseOut, 1).preExisting;
}

/** Stable text for the implementer brief: fixed order, no timestamps, so the bytes change only when the profile's content does. */
export function profileBrief(repoDir: string): string {
  const p = loadProfile(repoDir);
  if (!p || p.commands.length === 0) return "";
  const lines = (["test", "lint", "typecheck", "build"] as const).flatMap((k) => p.commands.filter((c) => c.kind === k).map((c) => `${k}: ${c.cmd}${c.validated === true ? " (validated on the untouched tree)" : c.validated === false ? " (could not run)" : ""}`));
  const base = p.baseline.attributable && p.baseline.failing_ids.length ? `Tests already failing before your change (not yours, do not fix): ${p.baseline.failing_ids.slice(0, 20).join("; ")}.` : "";
  return ["Repo commands (from the repo's manifests, do not rediscover):", ...lines, ...(base ? [base] : [])].join("\n");
}

export interface ReadinessFinding { id: string; severity: "high" | "medium" | "low"; message: string; fix: string }
export interface Readiness { score: number; grade: "A" | "B" | "C" | "D" | "F"; findings: ReadinessFinding[] }
export interface ReadinessHost { firstTaskReady: boolean; fix?: string | null }

/** Pure score of how ready a repo is for a verified run, from what the profile already recorded. 100 minus a cost per gap; a host that cannot run a first task caps it at 40. */
export function repoReadiness(p: CommandProfile, host?: ReadinessHost, verify: readonly ProfileCommand[] = []): Readiness {
  const findings: ReadinessFinding[] = [];
  let score = 100;
  const add = (cost: number, f: ReadinessFinding): void => { score -= cost; findings.push(f); };
  const has = (k: CmdKind): boolean => p.commands.some((c) => c.kind === k);
  const b = p.baseline;
  if (!has("test") && verify.length === 0) add(30, { id: "no-test-command", severity: "high", message: "No test command found in the repo manifests.", fix: "Add a test script (for example `npm run test`, `pytest`, `go test ./...`) so changes can be verified." });
  else if (!has("test")) { const miss = verify.find((c) => c.validated === false); if (miss) add(30, { id: "test-tool-missing", severity: "high", message: `Loki tests this repo with \`${miss.cmd}\` (from ${miss.source}), but ${miss.note}.`, fix: miss.fix ?? `Install the tool \`${miss.cmd.split(" ")[0]}\` needs.` }); } // FR05: verify's own full-suite command (computed at read time, never persisted)
  else if (!b.ran || b.timed_out || !b.attributable) add(15, { id: "baseline-unattributable", severity: "medium", message: `Baseline test run is not usable${b.reason ? ` (${b.reason})` : b.ran ? "" : " (not run)"}.`, fix: "Make the test command runnable from the repo root and finish within the baseline timeout so failures can be attributed." });
  else if (b.failing_ids.length > 0) add(20, { id: "baseline-red", severity: "medium", message: `Baseline is red: ${b.failing_ids.length} test(s) already fail before any change.`, fix: "Fix or quarantine them; until then `loki start` will not blame these on your change." });
  if (!has("lint")) add(10, { id: "no-lint", severity: "low", message: "No lint command found.", fix: "Add a lint script to the manifest." });
  if (!has("typecheck")) add(10, { id: "no-typecheck", severity: "low", message: "No typecheck command found.", fix: "Add a typecheck script (for example `tsc --noEmit`, `mypy`) to the manifest." });
  if (!has("build")) add(5, { id: "no-build", severity: "low", message: "No build command found.", fix: "Add a build script to the manifest." });
  for (const c of p.commands) if (c.validated === false) add(5, { id: "command-not-runnable", severity: "medium", message: `${c.kind} command \`${c.cmd}\` could not run${c.note ? ` (${c.note})` : ""}.`, fix: `Install its dependencies or correct the command in ${c.source}.` });
  if (host && !host.firstTaskReady) { score = Math.min(score, 40); findings.push({ id: "host-not-ready", severity: "high", message: "This machine cannot run a first task yet.", fix: host.fix ?? "Run `loki doctor --requirements` and follow its fixes." }); }
  score = Math.max(0, Math.min(100, score));
  return { score, grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 50 ? "D" : "F", findings };
}

/** The one-line Readiness notice for a run, or null when this repo already showed the same score (marker under .loki/state); a first run or a changed score returns it. */
export function readinessNotice(repoDir: string, r: Readiness): string | null {
  const marker = join(repoDir, ".loki", "state", "readiness-shown");
  let shown: string | null = null;
  try { shown = readFileSync(marker, "utf8").trim(); } catch { /* no marker: first run */ }
  if (shown === String(r.score)) return null;
  try { mkdirSync(join(marker, ".."), { recursive: true }); atomicWriteFileSync(marker, `${r.score}\n`); } catch { /* an unwritable marker only repeats the line */ }
  return `Readiness: ${r.score}/100 (${r.grade})${r.findings.length ? ` - run \`loki doctor --repo\` for ${r.findings.length} fix(es)` : ""}`;
}

export const readinessLines = (r: Readiness): string[] => [`  Readiness: ${r.score}/100 (${r.grade})`, ...(r.findings.length ? ["  Fix:", ...r.findings.map((f) => `    - ${f.fix}`)] : [])];

export function renderProfile(p: CommandProfile | null, host?: ReadinessHost, verify: readonly ProfileCommand[] = []): string {
  if (!p) return "repo profile: none yet (run `loki doctor --repo` to build it; LOKI_REPO_BASELINE=0 disables building)\n";
  const rows = p.commands.map((c) => `  ${c.kind.padEnd(9)} ${c.cmd}  [${c.source}]  ${c.validated === true ? `validated exit=${c.exit_code} ${c.duration_s}s` : c.validated === false ? `not runnable${c.note ? `: ${c.note}` : ""}` : "not executed"}`);
  const b = p.baseline;
  const bl = b.ran ? `${b.command} exit=${b.exit_code}${b.timed_out ? " (timed out)" : ""}, ${b.failing_ids.length} failing id(s)${b.attributable ? "" : `, not attributable${b.reason ? ` (${b.reason})` : ""}`}` : `not run (${b.reason ?? "unknown"})`;
  const vrows = verify.length ? ["  verify runs (no test command in the manifests):", ...verify.map((c) => `  test      ${c.cmd}  [${c.source}]  ${c.validated === false ? `not runnable: ${c.note}` : "not executed here"}`)] : [];
  return [".loki/state/repo-profile.json", `  revision ${p.revision.slice(0, 12)}  manifest ${p.manifest_hash.slice(0, 12)}  built ${p.created_at}`, ...rows, ...vrows, `  baseline: ${bl}`, ...readinessLines(repoReadiness(p, host, verify))].join("\n") + "\n";
}
