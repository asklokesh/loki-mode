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

import { armTimer, cmdSilenceS, defaultBudgetsOn } from "../engine10/types.ts"; import { MAX_STDOUT_BYTES, readStreamCapped } from "../util/shell.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { changeLines, comparableIds, errorsById, failedCount, failIds, idNamesFile, lineNamesChange, noiseOnlyErrors, sameErrors, sameFailures, SILENT_IDS_NOTE, unhandledBlock } from "../engine10/failures.ts"; import { redactSecrets } from "../util/redact.ts"; import { isTestFile } from "../util/test_file_text.ts";
import { baseRedShapeOn, suiteFacts, type StartFacts, loadErrorModule, classifyCheck, emptyDiscovery, exitCodedId, failureShape, goRunner, isExitCodedScript, plainTestEnv, resolveTool, spawnGroupSync, stripAnsi, toolFallbacks, type Classified } from "../util/check_result.ts";
import { safeGit, safeGitSpawn } from "../util/safe_git.ts";
import { lokiDir } from "../util/paths.ts";
import { atomicWriteFileSync } from "./state.ts";
import { inWorkspace, pkgWorkspaces, pnpmWorkspaces } from "../util/lock_ecosystems.ts";
import { bannedBy, guidesFor, GUIDE_HASH_FILES } from "../project_model/guides.ts";

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
  baseline: { ran: boolean; command: string | null; exit_code: number | null; duration_s: number | null; timed_out: boolean; failing_ids: string[]; attributable: boolean; reason?: string; zero_tests?: boolean; failing_unhandled?: string[]; failing_errors?: Record<string, string[]> /* FireLater#21: errorsById of the run, so a full suite is excused only for the same errors */; failing_shape?: string /* BASE-RED-SHAPE: failureShape of a red run whose ids were not parseable */; flaky_ids?: string[] /* ids that failed on exactly one of two base passes */; out_file?: string /* SILENT-IDS: the red run's whole output (secrets redacted), a file name under .loki/state/base-out */; out_sha256?: string /* of that file, checked on read: a later record of the same command writes the same name */; failed?: number /* SILENT-IDS: the failed count that run printed */; flaky_probe?: string /* "done", or why the second pass was skipped; absent on an entry written before the probe */; executed?: number /* EXOGENOUS-RED: tests the base run executed */; load_errors?: string[] /* EXOGENOUS-RED: its module-resolution lines, one per module */;
    start?: StartFacts /* UNRUNNABLE-CHECK: the error lines of a red, finished run and whether any is a start failure; absent on an entry written before the field */ };
  suites?: (CommandProfile["baseline"] & { name: string })[]; // FC-BASELINE-PER-PACKAGE: one per full-suite command verify runs; `command` is the check's cmd
}
export interface BaselineRun { code: number | null; timedOut: boolean; out: string; missing?: boolean }
export type BaselineRunner = (cmd: string, cwd: string, timeoutMs: number) => BaselineRun;

export const commandProfilePath = (repoDir: string): string => join(repoDir, ".loki", "state", "repo-profile.json");
/** One command's baseline budget: the same 5 minutes deep.ts gives that command's own run on the change (FULL_SUITE_TIMEOUT_MS is derived from this), so a suite that completes on head is never cut short on base (v131: tq's 250 s npm test got 60 s on base, timed out, and its pre-existing red was blamed on the change). */
export const BASELINE_CMD_TIMEOUT_S = 300;
/** A cut entry measured with a shorter budget than the current one is measured again; one cut at the current budget is kept (a hanging suite is not re-run for 5 minutes every time). */
/** A baseline command never gets more than a third of the run's overall cap. */
/** R3 LOKI_E10_INTAKE_CAP_S (opt-in since acc-148: unset, 0 or off keeps the per-command caps alone; a positive number of seconds enables it): one budget for all of intake's baseline test runs together (the root
 *  baseline, its rerun after an install, and the per-suite baselines). Before it, a suite that ran past the 300 s per-command cap was measured twice under two names, so
 *  intake spent 600 s on two cut-off runs that excuse nothing. A run cut by the budget is recorded as cut off, as before. The dependency install keeps its own cap. */
/** acc-148: off by default. The shared budget had no measured accuracy benefit and cut 6 of 65 past baselines (a complete 196 s gitea suite among them); a cut
 *  baseline is unattributable base red. When it is on and cuts a baseline, intakeBudgetNote prints one line ("loki: intake budget spent after N s ...") so runs can be counted. */
export const intakeCapS = (env: NodeJS.ProcessEnv = process.env): number | null => { const v = (env.LOKI_E10_INTAKE_CAP_S ?? "").trim(); const n = Number(v); return v !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };
export const INTAKE_BUDGET_LINE = "loki: intake budget spent after";
export function intakeBudgetNote(spentS: number, what: string): void { try { process.stderr.write(`${INTAKE_BUDGET_LINE} ${Math.round(spentS)} s (LOKI_E10_INTAKE_CAP_S): ${what}\n`); } catch { /* a note, never a reason to stop */ } }
/** NO-DEFAULT-BUDGET: one intake baseline command's limit. With LOKI_E10_DEFAULT_BUDGETS=1, 300 s (and a third of the cap) as before; otherwise the user's
 *  LOKI_E10_BASELINE_CMD_S, else a third of a user's run cap, else none (the command then stops only after cmdSilenceS() with no output). */
export const baselineCmdS = (capS: number | undefined, env: NodeJS.ProcessEnv = process.env): number => {
  if (defaultBudgetsOn(env)) return Math.max(1, Math.min(BASELINE_CMD_TIMEOUT_S, Math.floor((capS ?? Infinity) / 3)));
  const v = Number((env["LOKI_E10_BASELINE_CMD_S"] ?? "").trim()), user = (env["LOKI_E10_BASELINE_CMD_S"] ?? "").trim() !== "" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : Infinity;
  return Math.max(1, Math.min(user, Math.floor((capS ?? Infinity) / 3)));
};
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
  for (const f of [...MANIFESTS, ...GUIDE_HASH_FILES, ...workflowFiles(repoDir)].sort()) { // REPO-GUIDES: a guide edit changes the documented test command, so a stored profile is rebuilt
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
  return withGuides(repoDir, out);
}
/** REPO-GUIDES (project_model/guides.ts, the one reader of the repository's guides): the test command a guide documents leads the list (it is the baseline
 *  command), a discovered test command a guide forbids is dropped when a documented one stands in for it, and a test script found only in the script
 *  table (justfile, scripts/) fills in when nothing else names a test command. `source` stays a file path (the Project Model cites it); the line is in `note`. */
function withGuides(repoDir: string, out: ProfileCommand[]): ProfileCommand[] {
  const f = guidesFor(repoDir), named = f.tests.filter((t) => !t.needsPath), doc = named.find((t) => t.fromGuide);
  if (doc) {
    const same = out.find((e) => e.kind === "test" && e.cmd === doc.cmd), kept = out.filter((e) => e !== same && !(e.kind === "test" && bannedBy(f, e.cmd)));
    return [same ?? { ...entry("test", doc.cmd, doc.file), note: `from ${doc.source}` }, ...kept]; // a documented command the manifests already name keeps its manifest row, first
  }
  const fill = named[0];
  return fill && !out.some((e) => e.kind === "test") ? [...out, { ...entry("test", fill.cmd, fill.file), note: `from ${fill.source}` }] : out;
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
/** SETUP-PY-IS-PACKAGING (closed-set-2 hm155462): a file named setup.py is a package manifest only when it is a packaging script, one that imports setuptools
 *  or distutils. hermes-agent has four ordinary modules named setup.py (a setup wizard, helpers); each made its directory a package, Loki planned
 *  `python3 -m pip install -e .` there, and the run carried four "install exited 1" holds and "package hermes_cli defines no test command". Unreadable: not one. */
export function isPackagingSetupPy(repoDir: string, rel: string): boolean {
  try { return /^\s*(?:from|import)\s+(?:setuptools|distutils)\b/m.test(readFileSync(join(repoDir, rel), "utf8").slice(0, 262144)); } catch { return false; }
}
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
  tracked = tracked.filter((p) => basename(p) !== "setup.py" || isPackagingSetupPy(repoDir, p)); // SETUP-PY-IS-PACKAGING: a module that is only named setup.py is no manifest, here and in every reading below
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
export interface RepoFormatter { tool: string; argv: string[]; exts: RegExp; stdin?: (file: string) => string[]; alts?: { argv: string[]; stdin: (file: string) => string[] }[] }
/** FF LOKI_E10_FORMAT_FALLBACK (default on, =0 opts out): when the resolved formatter cannot start (spawn error, or a non-zero exit on the base text such as `uv run` with
 *  no ruff in the task venv), the commit stage tries the same fallbacks verify's linter uses (util/check_result.ts toolFallbacks: `uvx ruff`, then the repo venv's
 *  `python -m ruff`, unpinned like the linter) and keeps the first that runs. The base-clean rule is unchanged: a file whose base text the chosen formatter would change is
 *  never formatted. The failure: lint passed through `uvx ruff` while the formatter, with no fallback, skipped every file and the judge failed style. */
export const formatFallbackEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_FORMAT_FALLBACK"] ?? "").trim());
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
    const alts = formatResolveEnabled(env) && formatFallbackEnabled(env) ? toolFallbacks(repoDir, "ruff", env).map(([c, p]) => ({ argv: [c, ...p, "format"], stdin: (f: string) => [c, ...p, "format", "--stdin-filename", f, "-"] })) : [];
    out.push({ tool: "ruff", argv: [cmd, ...pre, "format"], exts: /\.pyi?$/, stdin: (f) => [cmd, ...pre, "format", "--stdin-filename", f, "-"], ...(alts.length ? { alts } : {}) });
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
export interface FormatRecord { tool: string; cmd: string; formatted: string[]; skipped: { file: string; why: string }[]; error?: string; fallback?: string }
/** Runs each detected formatter once over the regular files (no symlinks) it owns. With LOKI_E10_FORMAT_RESOLVE on and a base commit, a file present on base whose base text is not
 *  formatter-clean (the formatter's stdin mode prints something else, or fails) is left alone. A missing binary or nonzero exit formats nothing and is recorded. env must already be token-free. */
export function runFormattersRecord(repoDir: string, files: string[], env: NodeJS.ProcessEnv, baseSha?: string): { formatted: string[]; records: FormatRecord[] } {
  const fmts = detectFormatters(repoDir, env), check = formatResolveEnabled(env) && !!baseSha;
  const mine = fmts.length ? files.filter((f) => { try { return lstatSync(join(repoDir, f)).isFile(); } catch { return false; } }) : [];
  const records: FormatRecord[] = [], formatted: string[] = [];
  for (const fm0 of fmts) {
    const own = mine.filter((f) => fm0.exts.test(f)); if (!own.length) continue;
    const fm = pickRunnable(repoDir, fm0, own[0]!, env, baseSha); // FF: the first variant that starts, else the resolved one (its failure is recorded below)
    const rec: FormatRecord = { tool: fm.tool, cmd: fm.argv.join(" "), formatted: [], skipped: [], ...(fm !== fm0 ? { fallback: `${fm0.argv.join(" ")} could not start; used ${fm.argv.join(" ")}` } : {}) };
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
/** FF: whether a formatter variant starts: its stdin form run on one file's base text (or its current text when it is new) exits 0. */
function startsOn(repoDir: string, stdin: (f: string) => string[], f: string, env: NodeJS.ProcessEnv, baseSha?: string): boolean {
  let text: string | null = null;
  if (baseSha) { const b = safeGitSpawn(repoDir, ["show", `${baseSha}:${f}`], { encoding: "utf8" }); if (b.status === 0) text = b.stdout; }
  if (text === null) { try { text = readFileSync(join(repoDir, f), "utf8"); } catch { return false; } }
  const [c, ...a] = stdin(f), r = spawnSync(c!, a, { cwd: repoDir, env, input: text, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return !r.error && r.status === 0;
}
/** FF: the resolved formatter when it starts or has no fallback; else the first fallback that starts; else the resolved one (so its failure is what gets recorded). */
export function pickRunnable(repoDir: string, fm: RepoFormatter, probeFile: string, env: NodeJS.ProcessEnv, baseSha?: string): RepoFormatter {
  if (!fm.alts?.length || !fm.stdin || startsOn(repoDir, fm.stdin, probeFile, env, baseSha)) return fm;
  for (const alt of fm.alts) if (startsOn(repoDir, alt.stdin, probeFile, env, baseSha)) return { tool: fm.tool, exts: fm.exts, argv: alt.argv, stdin: alt.stdin };
  return fm;
}
/** The formatted files only (the commit stage re-stages them). */
export function runFormatters(repoDir: string, files: string[], env: NodeJS.ProcessEnv, baseSha?: string): string[] { return runFormattersRecord(repoDir, files, env, baseSha).formatted; }

/** Default runner: `sh -c` in repoDir, an explicit scoped env (token-free, no color, no bytecode litter), SIGKILL on timeout. */
export const shellRunner: BaselineRunner = (cmd, cwd, timeoutMs) => {
  if (!Number.isFinite(timeoutMs)) { const g = spawnGroupSync("sh", ["-c", cmd], { cwd, env: { ...plainTestEnv(), PYTHONDONTWRITEBYTECODE: "1", CI: "1" }, timeoutMs }); return { code: g.status, timedOut: g.status === null, out: stripAnsi(g.output), missing: g.status === 127 }; } // NO-DEFAULT-BUDGET: no limit runs under the silence guard (spawnSync has none)
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
  return measured(repoDir, cmd, r, dur);
}
const baseFacts = (out: string): { executed?: number; load_errors?: string[]; start?: StartFacts } => suiteFacts(out);
/** One finished base run as a baseline record (shared by intake's blocking run and verify's on-demand run). */
/** SILENT-IDS: a red base run's whole output is kept beside the profile (secrets redacted, at most BASE_OUT_MAX bytes; a longer one is not kept and the
 *  silent ids of that suite are then not comparable), because which lines name the change is only known once there is a change. */
export const BASE_OUT_DIR = "base-out", BASE_OUT_MAX = 16 * 1024 * 1024;
const baseOutPath = (repoDir: string, name: string): string => join(repoDir, ".loki", "state", BASE_OUT_DIR, name);
function baseOutFacts(repoDir: string, cmd: string, out: string, red: boolean): { out_file?: string; out_sha256?: string; failed?: number } {
  if (!red) return {};
  const failed = failedCount(out), res: { out_file?: string; out_sha256?: string; failed?: number } = failed === null ? {} : { failed };
  try {
    const text = redactSecrets(stripAnsi(out)); if (Buffer.byteLength(text, "utf8") > BASE_OUT_MAX) return res;
    const name = `${createHash("sha256").update(cmd).digest("hex").slice(0, 16)}.txt`; mkdirSync(dirname(baseOutPath(repoDir, name)), { recursive: true }); writeFileSync(baseOutPath(repoDir, name), text); res.out_file = name; res.out_sha256 = createHash("sha256").update(text).digest("hex");
  } catch { /* not kept: the silent ids of this suite are not comparable */ }
  return res;
}
/** SILENT-IDS: the changed files a failure line is read against. A test file the change ADDED is left out: no test that existed before can run through it,
 *  its own tests are ids of their own (never excused: an id that names a changed file is the change's), and a runner's progress line for it ("ok
 *  test_new.py") would otherwise read as the change showing up in an old failure (hermes-agent: 1 such line among 4.6 MB kept 468 ids refused). A test
 *  file the change EDITED, and every other changed file, stays in. */
const linesChangedMemo = new Map<string, string[]>();
export function changedForLines(repoDir: string, baseSha: string | undefined, changed: readonly string[]): string[] {
  const k = `${repoDir}\0${baseSha ?? ""}\0${changed.join("\0")}`, hit = linesChangedMemo.get(k); if (hit) return hit;
  const onBase = (f: string): boolean => { if (!baseSha) return true; try { safeGit(repoDir, ["cat-file", "-e", `${baseSha}:${f}`], { stdio: "ignore" }); return true; } catch { return false; } };
  const out = changed.filter((f) => !(isTestFile(f) && !onBase(f)));
  linesChangedMemo.set(k, out); return out;
}
/** The base side of SILENT-IDS for one record: the lines of its kept output that name the change, and its failed count. */
export function baseSideFacts(repoDir: string, b: { out_file?: string; out_sha256?: string; failed?: number } | undefined, changed: readonly string[], symbols: readonly string[]): { lines: string[] | null; failed: number | null } {
  let lines: string[] | null = null;
  try { if (b?.out_file && /^[0-9a-f]{16}\.txt$/.test(b.out_file)) { const text = readFileSync(baseOutPath(repoDir, b.out_file), "utf8"); if (b.out_sha256 && createHash("sha256").update(text).digest("hex") === b.out_sha256) lines = changeLines(text, changed, symbols); } } catch { lines = null; }
  return { lines, failed: b?.failed ?? null };
}
function measured(repoDir: string, cmd: string, r: BaselineRun, dur: number): { b: CommandProfile["baseline"]; missing: boolean } {
  const ids = r.code !== 0 && !r.timedOut ? (failIds(r.out).length ? failIds(r.out) : isExitCodedScript(cmd) && r.code !== null ? [exitCodedId(cmd, r.out, repoDir) ?? []].flat() as string[] : []) : [], missing = r.missing === true;
  const attributable = !r.timedOut && !missing && r.code !== null && (r.code === 0 || ids.length > 0);
  const reason = attributable ? undefined : r.timedOut ? "timed out" : missing ? "command not found" : "failing test ids not parseable, failures cannot be attributed";
  return { b: { ran: true, command: cmd, exit_code: r.code, duration_s: dur, timed_out: r.timedOut, failing_ids: ids, attributable, ...(reason ? { reason } : {}), ...(ids.length ? { failing_errors: Object.fromEntries(errorsById(r.out)) } : {}), ...(!attributable && !r.timedOut && r.code !== 0 && baseRedShapeOn() ? { failing_shape: failureShape(r.out) } : {}), ...(unhandledBlock(r.out).length ? { failing_unhandled: unhandledBlock(r.out) } : {}), ...baseFacts(r.out), ...baseOutFacts(repoDir, cmd, r.out, ids.length > 0), zero_tests: r.code === 0 && emptyDiscovery(classifyCheck({ kind: "test", ok: true, out: r.out, ...goRunner(cmd) }), r.out) }, missing };
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
  return { b: probeMerge(b, runOnce(repoDir, cmd, cwd, tmo, opts).b), missing: first.missing };
}
/** The first base pass with what a second pass adds: the ids red on exactly one of the two are flaky. */
function probeMerge(b: CommandProfile["baseline"], second: CommandProfile["baseline"]): CommandProfile["baseline"] {
  if (second.timed_out || second.exit_code === null) return { ...b, flaky_probe: "skipped: second pass did not finish" };
  const one = new Set(b.failing_ids), two = new Set(second.failing_ids), flaky = [...one].filter((i) => !two.has(i)).concat([...two].filter((i) => !one.has(i)));
  return { ...b, flaky_probe: "done", ...(flaky.length ? { flaky_ids: flaky, failing_errors: { ...(second.failing_errors ?? {}), ...(b.failing_errors ?? {}) } } : {}) };
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
/** ONE-BASE-RUN (acc-171, LOKI_E10_ONE_BASE_RUN default on, =0 opts out): package_suite.ts spells a root suite with the repo's absolute path
 *  ("/repo/.venv/bin/python -m pytest -q") where the root baseline ran it relative (".venv/bin/python -m pytest -q"): the same command, so intake ran the
 *  same suite twice (copier: a 300 s capped baseline, then 286 s again; 43 of 236 stored dev2/dev3 intakes ran a suite twice this way, 31 with identical
 *  results). The repo dir prefix of the first word is dropped before comparing, so the baseline speaks for the suite (rootSpeaks) and verify finds it
 *  (baseFor). A root baseline cut off at its cap is not run again: verify's per-file base reruns cover the targeted tests, and an incomplete base never excuses. */
export const oneBaseRunOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_ONE_BASE_RUN"] ?? "").trim());
export function repoRelCmd(repoDir: string, cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  const c = normCmd(cmd); if (!oneBaseRunOn(env) || !repoDir) return c;
  const dirs = [repoDir.replace(/\/+$/, "")]; try { dirs.push(realpathSync(repoDir)); } catch { /* the spelled path only */ }
  for (const d of [...new Set(dirs.flatMap((x) => [x, x.startsWith("/private/") ? x.slice("/private".length) : `/private${x}`]))]) if (c.startsWith(`${d}/`)) return normCmd(c.slice(d.length + 1));
  return c;
}
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
  return all.find((b) => normCmd(b.command ?? "") === normCmd(cmd)) ?? all.find((b) => repoRelCmd(repoDir, b.command ?? "") === repoRelCmd(repoDir, cmd)) ?? ((!ranOnly || p.baseline.ran) && sameRootScript(repoDir, p.baseline.command ?? "", cmd) ? p.baseline : undefined);
}
export const SUITE_BASELINE_BUDGET_S = 300;
/** NO-DEFAULT-BUDGET: the shared budget for the per-package suite baselines: 300 s only with LOKI_E10_DEFAULT_BUDGETS=1; LOKI_E10_INTAKE_CAP_S is the user's own. */
export const suiteBaselineBudgetS = (env: NodeJS.ProcessEnv = process.env): number => (defaultBudgetsOn(env) ? SUITE_BASELINE_BUDGET_S : Infinity);
/** RW-01 BASE-ON-DEMAND (LOKI_E10_BASE_ON_DEMAND, default on, =0 opts out): in a repository with a package suite below the root, intake no longer runs every
 *  package's suite on base before the model starts (opencode#63152: 308 s of a 900 s run went to 4 of 36 suites, the other 32 were never measured). Each
 *  suite is recorded not run (BASE_DEFERRED, attributable:false), so every reader fails closed, and verify measures on a base worktree only the suites
 *  that are red on head (baselineSuiteOnDemand), into the same `suites` record. A repository whose only suite is the root's behaves as before. */
export const baseOnDemandOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_BASE_ON_DEMAND"] ?? "").trim());
export const BASE_DEFERRED = "deferred: measured on base on demand, after implement";
export type AsyncBaselineRunner = (cmd: string, cwd: string, timeoutMs: number) => Promise<ReturnType<BaselineRunner>>;
/** shellRunner without blocking the event loop (a stage limit or the run cap must be able to stop it): the same `sh -c`, the same scoped env, its own
 *  process group killed whole at the timeout or when `signal` aborts. A stopped run reads as timed out. */
export const asyncShellRunner = (signal?: AbortSignal): AsyncBaselineRunner => async (cmd, cwd, timeoutMs) => {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, env: { ...plainTestEnv(), PYTHONDONTWRITEBYTECODE: "1", CI: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let stopped = false; const kill = (): void => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } }, stop = (): void => { stopped = true; kill(); };
  // NO-DEFAULT-BUDGET: a base run with no limit (Infinity) arms no timer (Bun fires one at once) and stops only after cmdSilenceS() with no output.
  const timer = armTimer(stop, timeoutMs), open = !Number.isFinite(timeoutMs); let last = Date.now(); const touch = (): void => { last = Date.now(); };
  const quiet = open ? setInterval(() => { if (Date.now() - last >= cmdSilenceS() * 1000) stop(); }, Math.min(30_000, Math.max(50, cmdSilenceS() * 250))) : undefined;
  if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  try {
    const [o, e, code] = await Promise.all([open ? readStreamCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_STDOUT_BYTES, undefined, touch) : new Response(proc.stdout).text(), open ? readStreamCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_STDOUT_BYTES, undefined, touch) : new Response(proc.stderr).text(), proc.exited]);
    return { code: stopped ? null : code, timedOut: stopped, out: stripAnsi(`${o}\n${e}`).slice(-8 * 1024 * 1024), missing: code === 127 };
  } finally { timer.clear(); if (quiet) clearInterval(quiet); signal?.removeEventListener("abort", stop); kill(); }
};
/** FC-BASELINE-PER-PACKAGE: a baseline per full-suite command verify will run (`specs`: package_suite.ts fullSuiteSpecs, the one source), added to the
 *  profile ensureProfile wrote for this HEAD. An entry for the same command is reused unless `rerun` (a dependency install succeeded
 *  since, so a baseline measured before it is stale: the main baseline and every entry are re-run, attributable or not). A root command the main baseline already ran is not run twice. One shared
 *  budget; a suite past it is recorded not run, so nothing it fails is excused (fail-closed). Never throws: null when there is no current profile. */
export function baselineSuites(repoDir: string, specs: { name: string; cmd: string; cwd: string; run: string }[], opts: BuildOpts & { rerun?: boolean; budgetS?: number; deadlineMs?: number; budgetSpentS?: number } = {}): CommandProfile | null {
  try {
    const p = loadProfile(repoDir);
    if (!p || p.revision !== headOf(repoDir)) return null;
    const dl = (): number => (opts.deadlineMs === undefined ? Infinity : Math.floor((opts.deadlineMs - Date.now()) / 1000)); // R3 intake cap: what is left of intake's baseline budget
    if (opts.rerun && p.baseline.ran && dl() >= 1) p.baseline = runBaseline(repoDir, p.commands, opts.deadlineMs === undefined ? opts : { ...opts, timeoutS: Math.max(1, Math.min(opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S, dl())) });
    let left = Math.min(opts.budgetS ?? suiteBaselineBudgetS(), dl());
    const old = p.suites ?? [];
    const rootSpeaks = (run: string): boolean => repoRelCmd(repoDir, run) === repoRelCmd(repoDir, p.baseline.command ?? "") || (p.baseline.ran && p.baseline.attributable && !p.baseline.timed_out && sameRootScript(repoDir, p.baseline.command ?? "", run)); // an alias is reused only when its base run is complete and attributable; otherwise the suite is measured under its own command
    const lazy = baseOnDemandOn() && (specs.some((s) => s.cwd !== ".") || p.baseline.reason === BASE_DEFERRED); // RW-01: a repository with a package suite below the root measures its suites on demand (verify), never all of them here
    p.suites = specs.filter((s) => s.cwd !== "." || !rootSpeaks(s.run)).map((s) => {
      const prev = old.find((o) => o.command === s.cmd);
      if (lazy) return prev?.ran && !opts.rerun && !prev.timed_out && (prev.failing_ids.length === 0 || (prev.failing_errors && prev.flaky_probe !== undefined)) ? prev : { name: s.name, ran: false, command: s.cmd, exit_code: null, duration_s: null, timed_out: false, failing_ids: [], attributable: false, reason: BASE_DEFERRED };
      if (prev?.ran && !opts.rerun && !cutShort(prev, Math.min(opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S, Math.floor(left))) && (prev.failing_ids.length === 0 || (prev.failing_errors && prev.flaky_probe !== undefined))) return prev; // an entry recorded before failing_errors existed is measured again
      const tmo = Math.min(opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S, Math.floor(left)), t0 = Date.now();
      if (tmo < 1) { if (opts.deadlineMs !== undefined) intakeBudgetNote((opts.budgetSpentS ?? 0) + (opts.budgetS ?? SUITE_BASELINE_BUDGET_S) - left, `${s.name} not measured on base`); return { name: s.name, ran: false, command: s.cmd, exit_code: null, duration_s: null, timed_out: false, failing_ids: [], attributable: false, reason: "baseline budget used up" }; }
      const { b } = runProbed(repoDir, s.run, join(repoDir, s.cwd), tmo, opts);
      if (b.timed_out && opts.deadlineMs !== undefined && tmo < (opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S)) intakeBudgetNote((opts.budgetSpentS ?? 0) + (opts.budgetS ?? SUITE_BASELINE_BUDGET_S) - left + tmo, `${s.name} cut off on base after ${tmo} s`);
      left -= (Date.now() - t0) / 1000;
      return { name: s.name, ...b, command: s.cmd };
    });
    save(repoDir, p);
    return p;
  } catch { return null; }
}
/** RW-01 BASE-ON-DEMAND: measures one full-suite command on base, after implement, and writes the record intake no longer writes. `baseDir` is a checkout of
 *  the base commit (verify's detached base worktree, dependency dirs already linked by the caller); `spec.run` runs in `spec.cwd` under it, through
 *  `runner` (asyncShellRunner with the stage's signal). The record goes into the profile only when the profile is for `baseSha` and the run was not
 *  stopped by `stopped()` (a stage stop: a half-run base must not be read by a later run). A suite the root baseline speaks for is written as the root
 *  baseline when that was deferred. True when a usable record exists afterwards (measured now, or already measured on this commit). Never throws. */
export async function baselineSuiteOnDemand(repoDir: string, baseSha: string, spec: { name: string; cmd: string; cwd: string; run: string }, baseDir: string, runner: AsyncBaselineRunner, timeoutS: number, stopped: () => boolean = () => false): Promise<boolean> {
  try {
    const p = loadProfile(repoDir);
    if (!p || !baseSha || p.revision !== baseSha || timeoutS < 1) return false;
    const usable = (b: CommandProfile["baseline"] | undefined): boolean => !!b?.ran && !cutShort(b, timeoutS) && (b.failing_ids.length === 0 || (!!b.failing_errors && b.flaky_probe !== undefined));
    const root = spec.cwd === "." && (repoRelCmd(repoDir, spec.run) === repoRelCmd(repoDir, p.baseline.command ?? "") || repoRelCmd(baseDir, spec.run) === repoRelCmd(repoDir, p.baseline.command ?? ""));
    if (usable(root ? p.baseline : p.suites?.find((o) => o.command === spec.cmd))) return true;
    if (root && p.baseline.ran && p.baseline.reason !== BASE_DEFERRED) return true; // intake measured the root command itself: that record stands, usable or not
    // the base worktree's own path is rewritten to the checkout's, so an error line or an output shape that carries an absolute path reads as it would have from a run in the checkout
    const dirs = [baseDir]; try { dirs.push(realpathSync(baseDir)); } catch { /* the spelled path only */ }
    const home = (out: string): string => { let o = out; for (const d of [...new Set(dirs.flatMap((x) => [x, x.startsWith("/private/") ? x.slice("/private".length) : `/private${x}`]))].sort((a, b) => b.length - a.length)) o = o.split(d).join(repoDir.replace(/\/+$/, "")); return o; };
    const one = async (): Promise<{ b: CommandProfile["baseline"]; missing: boolean }> => { const t0 = Date.now(), r = await runner(spec.run, join(baseDir, spec.cwd), timeoutS * 1000); return measured(repoDir, spec.run, { ...r, out: home(r.out) }, Math.round((Date.now() - t0) / 100) / 10); };
    const first = await one(); let b = first.b;
    if (stopped()) return false;
    if (!b.failing_ids.length) b = { ...b, flaky_probe: "done" };
    else if (b.timed_out || first.missing || (b.duration_s ?? 0) > FLAKE_PROBE_MAX_S) b = { ...b, flaky_probe: `skipped: first pass ${b.duration_s ?? "?"}s` };
    else { b = probeMerge(b, (await one()).b); if (stopped()) return false; }
    const cur = loadProfile(repoDir);
    if (!cur || cur.revision !== baseSha) return false;
    if (root) cur.baseline = { ...b, command: cur.baseline.command };
    else cur.suites = [...(cur.suites ?? []).filter((o) => o.command !== spec.cmd), { name: spec.name, ...b, command: spec.cmd }];
    save(repoDir, cur);
    return true;
  } catch { return false; }
}
/** RW-01: true when the manifests show a package with a test command below the repo root (manifestModel, no session): the repository whose root baseline
 *  intake defers along with its package suites. A workspace whose root test script fans out over every package answers true too. */
export function multiPackageRepo(repoDir: string): boolean {
  try { const m = manifestModel(repoDir); if (!m) return false; if ("fanOut" in m) return true; return ((m["packages"] as { root: string; commands: { test: unknown } }[] | undefined) ?? []).some((x) => x.root !== "." && !!x.commands.test); } catch { return false; }
}

/** True only when the same full-suite command ran on exactly this base commit, exited 0 and discovered no tests (empty discovery, no skips), and `cls` is the head's empty discovery too: the suite was empty before the change as well, so it says nothing about the change. Anything else (no profile, a package directory with no suites entry, other revision, unmatched command, base executed or skipped tests) is false, so the head's 0-test result stays not_run. */
export function suiteEmptyOnBase(repoDir: string, baseSha: string | undefined, line: string, name: string, cls: Classified, out: string, cwd = "."): boolean {
  const p = baseSha ? loadProfile(repoDir) : null;
  if (!p || p.revision !== baseSha || !emptyDiscovery(cls, out)) return false;
  const e = p.suites?.find((x) => x.command === name) ?? (cwd === "." && (repoRelCmd(repoDir, p.baseline.command ?? "") === repoRelCmd(repoDir, line) || sameRootScript(repoDir, p.baseline.command ?? "", line)) ? p.baseline : undefined); // the root baseline speaks only for the repo root, never for a package directory
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
export function ensureProfile(repoDir: string, opts: BuildOpts & { defer?: boolean } = {}): { profile: CommandProfile; reused: boolean } | null {
  try {
    const hash = manifestHash(repoDir), rev = headOf(repoDir), old = loadProfile(repoDir);
    if (old && old.manifest_hash === hash && old.revision === rev && !(old.baseline.reason === BASE_DEFERRED && !opts.defer) && !cutShort(old.baseline, opts.timeoutS ?? BASELINE_CMD_TIMEOUT_S) && (old.baseline.failing_ids.length === 0 || (old.baseline.failing_errors && old.baseline.flaky_probe !== undefined))) return { profile: old, reused: true };
    const commands = old && old.manifest_hash === hash ? old.commands.map((c) => ({ ...c, ...(c.kind === "test" ? { validated: null, exit_code: null, duration_s: null, failing_ids: [] } : {}) })) : discoverCommands(repoDir);
    const t = commands.find((c) => c.kind === "test"); // RW-01 `defer` (intake, a multi-package repository): the root command is recorded, not run; verify measures it on base only if it is red on head
    const profile: CommandProfile = { version: 1, revision: rev, manifest_hash: hash, created_at: (opts.now?.() ?? new Date()).toISOString(), commands, baseline: opts.defer && t ? { ran: false, command: t.cmd, exit_code: null, duration_s: null, timed_out: false, failing_ids: [], attributable: false, reason: BASE_DEFERRED } : runBaseline(repoDir, commands, opts) };
    save(repoDir, profile);
    return { profile, reused: false };
  } catch { return null; }
}

/** Failing checks split by the baseline. A check is pre-existing only when the profile ran on exactly this base commit, the baseline was attributable,
 *  `eligible` (the caller: untouched, non-target test) and EVERY failing id of the check is in the baseline (one new id makes it introduced).
 *  A check without parsed ids is introduced: unknown never excuses a failure. FireLater#21: `suite` names the full-suite check of the package that
 *  owns the test (the caller's FC-BASELINE-PER-PACKAGE `suites` entry); its ids are that package's baseline, so a frontend page test in a repo whose
 *  root command runs nothing is compared with the frontend suite's base failures. No suite, or one that did not run attributably: the root baseline.
 *  `rerun` is what this run's own base rerun of the check showed: "same" (every failing id red there, failing the same way), "differs" (it ran the check's
 *  tests and they passed, failed by other ids or failed with another error), or absent (nothing to compare: it ran without its dependencies, was cut, or never ran).
 *  The suite baseline is read for "same"; never for "differs"; and when the rerun is absent only if every comparable failing id repeats the error lines
 *  the suite recorded for it on base (`errors` against failing_errors, sameErrors: no line on either side excuses nothing). An id match alone never
 *  excuses: a test already red on base can be broken by the change in a new way (v11.145.0 to v11.153.0 read ids alone here and sealed such runs
 *  VERIFIED). LOKI_E10_BASE_RED_BY_ID=0 never reads the suite for an absent rerun; =1 reads it by id alone (baseRedByIdOn, unsafe for the label). The
 *  caller passes `suite` for a check with no rerun only while the package's dependency dirs are as intake left them (verify.ts depsAsIntake).
 *  FireLater#24: the ignored frontend/next-env.d.ts changed during the session, every base rerun lost its node_modules and parsed no id, and 22 untouched
 *  page tests whose 146 failing ids were all in the frontend suite's 307 base failures blocked the run (and held the full suite with them). Measured on
 *  that run's tree: all 73 of their error lines equal the suite's recorded ones. */
export interface Attribution { preExistingChecks: string[]; preExistingIds: string[]; introducedChecks: string[]; line: string | null }
export function attribute(repoDir: string, baseSha: string, failing: { name: string; ids?: string[]; eligible: boolean; suite?: string; rerun?: "same" | "differs"; errors?: Map<string, string[]> | Record<string, string[]> }[]): Attribution {
  const p = loadProfile(repoDir), none: Attribution = { preExistingChecks: [], preExistingIds: [], introducedChecks: failing.map((f) => f.name), line: null };
  if (!p || p.revision !== baseSha || failing.length === 0) return none;
  const rec = (name?: string) => (name ? p.suites?.find((x) => x.name === name && x.ran && x.attributable) : undefined), root = p.baseline.attributable ? p.baseline.failing_ids : [], own = (name?: string): string[] => rec(name)?.failing_ids ?? root;
  // the absent rerun: the same error lines as the suite recorded on base, or nothing (ids alone only under the explicit, unsafe =1)
  const sameWay = (f: (typeof failing)[number]): boolean => { const be = rec(f.suite)?.failing_errors; return !!be && !!f.errors && sameErrors(f.errors instanceof Map ? f.errors : new Map(Object.entries(f.errors)), be, comparableIds(f.ids ?? [])); };
  const absent = (f: (typeof failing)[number]): boolean => f.rerun === undefined && !!f.suite && (baseRedByIdOn() || (!baseRedSuiteOff() && sameWay(f)));
  const rows = failing.map((f) => ({ ...f, base: new Set(own(f.rerun === "same" || absent(f) ? f.suite : undefined)) })), known = new Set(rows.flatMap((r) => [...r.base]));
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
type FullCheck = { name: string; cmd: string; result: string; ids?: string[]; errors?: Record<string, string[]>; unhandled?: string[]; exit?: number | null; shape?: string; executed?: number; load_errors?: string[]; change_lines?: string[] | null; failed?: number | null; start?: StartFacts };
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
/** EXOGENOUS-RED (LOKI_E10_EXOGENOUS_RED, default on; =0/off/false/no opts out, which leaves only the stopped-verify rule of 11.162.0). A failing test or suite
 *  the run did not write (exogenous) makes the run FAILED only when it is attributed to the change. Otherwise Loki could not tell a failure the change caused
 *  from the ones already there, and the check holds the label at PARTIAL; it is never excused by this. One state per failing check, decided in this order, with
 *  the evidence the receipt line prints:
 *    not started      no base record for this commit and command, or it never ran ("deferred", "not measured on base")
 *    cut              the base run was stopped (timed out, or the baseline budget ran out)
 *    not comparable   the base run passed but executed no test; or it could not load a module that the head run loaded (its tree lacks what the checkout has);
 *                     or, only when the change edits no test file, it executed fewer than half the tests the head run executed
 *    compared         the base run was compared and did not excuse the check, so it blames the change. `fresh` >= 1 when: the base run passed and head fails; head could not load a module that base loaded; base printed
 *                     failing ids and head prints none; or a head failing id is not red on base (flaky base ids count as red). `fresh` 0: every id is red on base
 *    unattributable   the base run was red and printed no failing id that can be read, or head printed none against such a base
 *  The half-count test is off when the change edits a test file: added tests raise head's count by themselves, and a new failure among them must be compared.
 *  closed-set-2 (11.158.0 to 11.164.0): pw43305 unattributable (six of six seeds), hm155462 and oc63960 not started or not comparable; takes over BASE-UNATTRIBUTED. */
export const exogenousRedOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_EXOGENOUS_RED"] ?? "").trim());
export type BaseState = "compared" | "cut" | "not started" | "unattributable" | "not comparable";
export interface ExogenousAttribution { state: BaseState; fresh: number; names_changed: boolean; evidence: string; exit?: number | null; base_exit?: number | null; fresh_ids?: string[] } // fresh_ids: the failing ids not red on base (seal measuredConflictOf reads them)
/** The half-count test: a base run that executed fewer than half of what head executed did not run the same suite. */
export const baseRanTooFew = (base: number | undefined, head: number | null | undefined): boolean => typeof base === "number" && typeof head === "number" && head > 0 && base * 2 < head;
export function exogenousState(repoDir: string, baseSha: string, c: FullCheck, testsChanged = false): Pick<ExogenousAttribution, "state" | "fresh" | "evidence" | "exit" | "base_exit" | "fresh_ids"> {
  const p = loadProfile(repoDir), b0 = p && p.revision === baseSha ? baseFor(repoDir, p, c.cmd, false) : undefined;
  const st = (state: BaseState, fresh: number, evidence: string, freshIds?: string[]) => ({ state, fresh, evidence, exit: c.exit ?? null, base_exit: b0?.exit_code ?? null, ...(freshIds ? { fresh_ids: freshIds } : {}) });
  if (!p || p.revision !== baseSha) return st("not started", 0, "no base record for this commit");
  if (!b0 || !b0.ran) return st("not started", 0, b0?.reason ?? "the base run of this command did not start");
  if (b0.timed_out || b0.reason === "baseline budget used up") return st("cut", 0, b0.timed_out ? "the base run timed out" : "the baseline budget ran out");
  const ids = comparableIds(c.ids ?? []);
  if (b0.exit_code === 0) { // a base run that passed is a comparison that blames the change whatever head printed, unless it passed by running nothing
    if (b0.zero_tests === true || b0.executed === 0) return st("not comparable", 0, "the base run passed without executing a test");
    if (!testsChanged && baseRanTooFew(b0.executed, c.executed)) return st("not comparable", 0, `the base run passed but ran ${b0.executed} of head's ${c.executed} tests`); // head's failures can be in tests base never ran
    return st("compared", Math.max(1, ids.length), "the base run passed and the head run fails", ids); // base passed: every failing id is fresh
  }
  const bm = new Map((b0.load_errors ?? []).map((l) => [loadErrorModule(l), l] as const)), hm = new Map((c.load_errors ?? []).map((l) => [loadErrorModule(l), l] as const));
  const baseOnly = [...bm.keys()].filter((m) => !hm.has(m)), headOnly = [...hm.keys()].filter((m) => !bm.has(m));
  if (baseOnly.length) return st("not comparable", 0, `the base run could not load a module the head run loaded: ${bm.get(baseOnly[0]!)}`);
  if (headOnly.length) return st("compared", Math.max(1, headOnly.length), `the head run could not load a module the base run loaded: ${hm.get(headOnly[0]!)}`);
  if (!testsChanged && baseRanTooFew(b0.executed, c.executed)) return st("not comparable", 0, `base ran ${b0.executed} of head's ${c.executed} tests`);
  if (b0.attributable && b0.failing_ids.length > 0 && !ids.length) return st("compared", 1, `the base run printed failing ids and the head run printed none (exit base ${b0.exit_code}, head ${c.exit ?? "unknown"}): head failed in another way`);
  if (!b0.attributable) return st("unattributable", 0, b0.reason ?? "no failing id parsed on base");
  if (!ids.length) return st("unattributable", 0, "no failing id parsed on head");
  const known = new Set([...b0.failing_ids, ...(b0.flaky_ids ?? [])]), fresh = ids.filter((i) => !known.has(i));
  return st("compared", fresh.length, fresh.length ? `${fresh.length} failing id(s) not red on base (first: ${fresh[0]})` : "every failing id is red on base", fresh);
}
/** HEAD-RERUN (LOKI_E10_HEAD_RERUN, default on; =0/off/false/no opts out): the ids a suite's usable base record shows red (failing or flaky), or null when
 *  there is no such record for this commit and command (not run, cut, or not attributable): then nothing is rerun and nothing is dropped. */
export const headRerunOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_HEAD_RERUN"] ?? "").trim());
/** The head-only ids a rerun of the same command shows PASSED. An id missing from the rerun's failing ids is not a pass: the rerun may have stopped early
 *  (a bail flag, a crash) or its output may have been cut, and the id never ran or its line was lost. So an id is dropped only on positive evidence:
 *  the rerun's output is under the stream cap and it executed at least as many tests as the first head run (an exit 0 that discovered nothing, or a
 *  wrapper that exits 0 on its own, proves no pass), and then either it passed (exit 0) or it failed with a printed failed count equal to the failing ids
 *  read from it. Anything else drops nothing. */
export const RERUN_OUT_CAP = 8 * 1024 * 1024;
export function passedOnRerun(only: readonly string[], rerun: { code: number | null; out: string }, headExecuted: number | undefined): string[] {
  if (rerun.code === null || Buffer.byteLength(rerun.out, "utf8") >= RERUN_OUT_CAP - 4096) return [];
  const ran = suiteFacts(rerun.out).executed;
  if (typeof headExecuted !== "number" || typeof ran !== "number" || ran < 1 || ran < headExecuted) return []; // an exit 0 that ran nothing, or fewer tests than the first run, proves no pass either
  if (rerun.code === 0) return [...only];
  const again = new Set(failIds(rerun.out)), printed = failedCount(rerun.out);
  if (again.size === 0 || printed === null || printed !== again.size) return [];
  return only.filter((i) => !again.has(i));
}
export function baseRedIds(repoDir: string, baseSha: string, cmd: string): Set<string> | null {
  const p = loadProfile(repoDir), b = p && p.revision === baseSha ? baseFor(repoDir, p, cmd, false) : undefined;
  if (!b || !b.ran || b.timed_out || b.reason === "baseline budget used up" || (b.exit_code !== 0 && !b.attributable)) return null;
  return new Set([...b.failing_ids, ...(b.flaky_ids ?? [])]);
}
/** True when the attribution blames the change: only then may an exogenous red make the run FAILED. A compared check that is still failing was not
 *  excused by the base comparison, so the comparison itself found against the change: a failing id not red on base (`fresh`), or, with every id red on
 *  base (`fresh` 0), an error that differs from base, an id that names a changed file, or an id that also fails in a targeted check that was not excused
 *  (whyFullSuiteNotExcused prints which). Only a base run that could not be compared holds PARTIAL. */
export const attributedToChange = (a: Pick<ExogenousAttribution, "state" | "fresh" | "names_changed"> | undefined): boolean => !!a && (a.state === "compared" || a.names_changed);
/** LOKI_E10_BASE_UNATTRIBUTED=0 (the opt-out 11.163.0 documented) keeps its meaning: it turns off the "unattributable" state alone, so such a check is FAILED again. */
export const baseUnattributedOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_BASE_UNATTRIBUTED"] ?? "").trim());
/** True when the record holds the label at PARTIAL: not attributed to the change, and not an unattributable check with that state turned off. The one predicate verify (the receipt line) and seal (the verdict) both read. */
export const holdsPartial = (a: Pick<ExogenousAttribution, "state" | "fresh" | "names_changed">): boolean => !attributedToChange(a) && !(a.state === "unattributable" && !baseUnattributedOn());
/** UNRUNNABLE-CHECK (LOKI_E10_UNRUNNABLE_CHECK, default on; =0/off/false/no opts out). Founder decision 2026-11-20: a check that cannot run on the base commit
 *  or on the change, for the same reason, gives no evidence either way and does not block VERIFIED, when the change's own test fails before the change and
 *  passes after it (seal.ts unrunnableLifted decides that part). This file decides which checks could not run. `sameStartFailure`: both runs printed the same
 *  set of error lines, at least one of them a start failure (something missing before a test could run), none that reads like a test that ran and failed, no
 *  passed test on either side, and a failed count that is not higher on the change when both print one. A base record or check written before the facts
 *  existed is unknown, never unrunnable. What it cannot see: a failure the change caused that prints exactly the error text of a failure already on base, in
 *  a suite that prints no count or stops at a failure cap. */
export const unrunnableCheckOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_UNRUNNABLE_CHECK"] ?? "").trim());
export function sameStartFailure(base: StartFacts | undefined, head: StartFacts | undefined): boolean {
  if (!base || !head || base.more || head.more || base.lines.length === 0 || base.lines.length !== head.lines.length) return false;
  const b = new Set(base.lines); if (head.lines.some((l) => !b.has(l))) return false;
  if (base.start === 0 || head.start === 0 || base.assertion || head.assertion || base.passed || head.passed) return false;
  return base.failed === null ? head.failed === null : typeof head.failed === "number" && head.failed <= base.failed;
}
/** The failing full-suite checks that could not run on either side: its base run of the same command on this base commit finished red with the same exit
 *  code, neither side printed a failing test id, and the two runs show the same start failure. */
export function unrunnableSuites(repoDir: string, baseSha: string, full: FullCheck[]): string[] {
  const p = loadProfile(repoDir); if (!p || p.revision !== baseSha) return [];
  return full.filter((c) => {
    if (c.result !== "fail" || (c.ids ?? []).length > 0 || typeof c.exit !== "number") return false;
    const b = baseFor(repoDir, p, c.cmd, true);
    return !!b && b.ran && !b.timed_out && b.reason !== "baseline budget used up" && b.failing_ids.length === 0 && typeof b.exit_code === "number" && b.exit_code !== 0 && b.exit_code === c.exit && sameStartFailure(b.start, c.start);
  }).map((c) => c.name);
}
/** The checks rule (b) may lift, from the ones verify already found could not run: `suites` (unrunnableSuites) and `notRun` (a test file sealed not_run because
 *  it fails the same way with the change removed, or crashes with the same signature on base). One is kept only when no changed file is in its package
 *  (`pkgOf` gives a file's owning package root, `pkg` is the check's) and nothing it printed names a changed file (`namesChanged`). [] with the knob off. */
export function couldNotRun(cands: readonly { name: string; pkg: string; namesChanged: boolean }[], changed: readonly string[], pkgOf: (f: string) => string): string[] {
  if (!unrunnableCheckOn()) return [];
  const touched = new Set(changed.map(pkgOf));
  return cands.filter((c) => !c.namesChanged && !touched.has(c.pkg)).map((c) => c.name);
}
/** Point 2 relaxation (lead, 2026-11-20): the candidates that couldNotRun refuses ONLY because changed test files are in their package, with those files.
 *  Seal lifts such a check only when every one of those files is a test the change's own proof showed failing before the change and passing after it: the
 *  change is then proved directly and the unrunnable check adds nothing about it. A changed non-test file in the package always blocks, and so does output
 *  that names a changed file. {} with the knob off. */
export function couldNotRunIfProved(cands: readonly { name: string; pkg: string; namesChanged: boolean }[], changed: readonly string[], pkgOf: (f: string) => string, isTest: (f: string) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!unrunnableCheckOn()) return out;
  for (const c of cands) { if (c.namesChanged) continue; const inPkg = changed.filter((f) => pkgOf(f) === c.pkg); if (inPkg.length > 0 && inPkg.every(isTest)) out[c.name] = inPkg; }
  return out;
}
/** An install step that could not start because its own tool is not on this machine: the tool's name, or null. The base run and the run on the change share
 *  the machine, so a tool missing from PATH is the same start failure on both sides by construction. All of: the shell or the spawn said the tool was not found
 *  (exit 127, or ENOENT); the tool is a word of the install command itself, not of a script it ran; and the tool is still not on PATH now (`which`). */
export function missingTool(reason: string, cmd: string, which: (tool: string) => string | null = (t) => Bun.which(t)): string | null {
  if (!/^install (?:exited 127\b|could not start)/.test(reason)) return null;
  const m = /(?:^|[\s:])([A-Za-z0-9_.+-]+): (?:command )?not found\b/.exec(reason) ?? /\bspawn ([A-Za-z0-9_.+-]+) ENOENT\b/.exec(reason) ?? /\benv: ([A-Za-z0-9_.+-]+): No such file or directory/.exec(reason);
  const tool = m?.[1]; if (!tool || /^(?:line|bash|sh|zsh|env)$/.test(tool)) return null;
  if (!cmd.split(/[\s;&|()]+/).includes(tool)) return null;
  try { return which(tool) === null ? tool : null; } catch { return null; }
}
export const exogenousHeldLine = (name: string, a: Pick<ExogenousAttribution, "state" | "evidence">): string => `not attributed to this change, so it holds the label at PARTIAL and is not excused: ${name}: base run ${a.state} (${a.evidence})`;
export const SAME_RED_NOTE = "excused as red on base in the identical kind (same command, same exit code, the same unparseable output shape; no failing id could be compared)";
export function attributeFullSuite(repoDir: string, baseSha: string, full: FullCheck[], blocked: string[], changed: string[], symbols: readonly string[] = [], shownIds: ReadonlySet<string> = new Set()): Attribution {
  const same = sameUnattributableRed(repoDir, baseSha, full);
  const res = attributeFullSuiteById(repoDir, baseSha, same.length ? full.filter((c) => !same.includes(c.name)) : full, blocked, changed, symbols, shownIds);
  if (!same.length) return res;
  const note = full.filter((c) => same.includes(c.name)).map((c) => `NOT PROVEN: "${c.cmd}" was ${SAME_RED_NOTE}`).join("; ");
  return { ...res, preExistingChecks: [...res.preExistingChecks, ...same], introducedChecks: res.introducedChecks.filter((n) => !same.includes(n)), line: [res.line, note].filter(Boolean).join("; ") };
}
/** BASE-RED-BY-ID (default OFF; LOKI_E10_BASE_RED_BY_ID=1 opts in): UNSAFE for the label. With it on, a check whose every failing id was already failing on
 *  the base commit is pre-existing whatever its error says now (full suite, an edited or collateral test file, an absent base rerun). That was the default
 *  from v11.145.0 to v11.153.0 on the claim "a test that was red before the change cannot be broken by it". The claim is false: the change can break it
 *  in a new way (an AssertionError on base, a TypeError on head; an asserted value that moved), and those runs were sealed VERIFIED. The default is the
 *  rule the units specify: an id match excuses only with the same error lines, or lines that differ by noise alone and name no changed file or symbol.
 *  The FireLater#24 run behind the switch (6d70) was re-measured: 150 of its 152 failing ids repeat their base error and 2 Header.test.tsx ids fail with
 *  another message after header.tsx was edited, so it is not excused, by design. */
export const baseRedByIdOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_E10_BASE_RED_BY_ID"] ?? "").trim());
/** LOKI_E10_BASE_RED_BY_ID=0: the strictest setting. attribute() never reads a package's suite baseline for a check whose base rerun gave nothing to compare. */
const baseRedSuiteOff = (env: NodeJS.ProcessEnv = process.env): boolean => /^(0|off|false|no)$/i.test((env["LOKI_E10_BASE_RED_BY_ID"] ?? "").trim());
function attributeFullSuiteById(repoDir: string, baseSha: string, full: FullCheck[], blocked: string[], changed: string[], symbols: readonly string[] = [], shownIds: ReadonlySet<string> = new Set()): Attribution { // shownIds: TOUCHED-BASE-RED ids an edited file's own run showed red on base with the same error; only they may name that changed file here
  const bad = full.filter((c) => c.result === "fail"), none: Attribution = { preExistingChecks: [], preExistingIds: [], introducedChecks: bad.map((c) => c.name), line: null }, p = loadProfile(repoDir);
  if (!bad.length || !p || p.revision !== baseSha) return none;
  const runs = [p.baseline, ...(p.suites ?? [])].filter((b) => b.ran), of = (cmd: string) => baseFor(repoDir, p, cmd, true);
  // A base run that was cut off (its time or the shared baseline budget ran out) says nothing about which failures were already there: record it, never blame silently.
  const cut = bad.filter((c) => { const b = baseFor(repoDir, p, c.cmd, false); return !!b && (b.timed_out || b.reason === "baseline budget used up"); });
  if (cut.length) return { ...none, line: `NOT PROVEN: base run incomplete for ${cut.map((c) => `"${c.cmd}"`).join(", ")} (cut off on the original code), so its failures are not excusable` };
  const ids = (cmd: string): string[] => { const b = of(cmd); return b?.attributable ? [...b.failing_ids, ...(b.flaky_ids ?? [])] : []; }, miss = bad.find((c) => !of(c.cmd));
  if (miss) return { ...none, line: `baseline: ran ${runs.map((b) => `"${b.command}"`).join(", ") || "nothing"}, not the full suite command "${miss.cmd}", ids not comparable, full suite failures not excused` };
  const massive = (cmd: string): boolean => (of(cmd)?.failing_ids.length ?? 0) >= MASSIVE_RED_IDS, known = new Set(bad.flatMap((c) => ids(c.cmd))), block = new Set(blocked), sameAsBase = (c: (typeof bad)[number]): boolean => { const b = of(c.cmd), be = b?.failing_errors, hu = c.unhandled ?? [], bu = b?.failing_unhandled ?? []; /* every id, flaky or not, must repeat its stored base error (a flaky id keeps the error of the pass it failed on), at the same multiplicity, whatever the suite size */ return !!be && !!c.errors && hu.length === bu.length && hu.every((x, n) => x === bu[n]) /* an unhandled-errors block names no id: it must repeat on base */ && silentOf(c).same; }, /* SILENT-IDS: ids with no error line on either side are compared by the lines naming the change */ silentOf = (c: (typeof bad)[number]): { same: boolean; silent: number } => { const b = of(c.cmd); return b?.failing_errors && c.errors ? sameFailures(new Map(Object.entries(c.errors)), b.failing_errors, comparableIds(c.ids ?? []), { lines: c.change_lines ?? null, failed: c.failed ?? null }, baseSideFacts(repoDir, b, changedForLines(repoDir, baseSha, changed), symbols)) : { same: false, silent: 0 }; },
    /* fl24: the second chance when the text differs: the same unhandled block, the same error shapes (noise only) and no head error line naming a changed file or symbol (noiseOnlyErrors); listed NOT PROVEN below */ quietAsBase = (c: (typeof bad)[number]): boolean => { const be = of(c.cmd)?.failing_errors, hu = c.unhandled ?? [], bu = of(c.cmd)?.failing_unhandled ?? []; return !!be && !!c.errors && hu.length === bu.length && hu.every((x, n) => x === bu[n]) && noiseOnlyErrors(c.errors, be, comparableIds(c.ids ?? []), changed, symbols); },
    /* a flaky id, or any id of a suite red at base, whose head error text names a file the change edited is the change's own failure, whatever the id */ errNamesChanged = (c: (typeof bad)[number]): boolean => { const fl = new Set(of(c.cmd)?.flaky_ids ?? []), all = massive(c.cmd), keys = Object.keys(c.errors ?? {}).filter((k) => all || [...fl].some((i) => k === i || k.endsWith(` > ${i}`))); return keys.some((k) => (c.errors?.[k] ?? []).some((l) => changed.some((f) => l.includes(f)))); };
  if (known.size === 0) return none;
  const unproven = [...new Set(bad.flatMap((c) => c.ids ?? []).filter((i) => !i.includes("::") && goIdTouched(repoDir, i, changed)))];
  const res = split(bad.map((c) => ({ name: c.name, ...(c.ids ? { ids: c.ids } : {}), eligible: !cargoTouched(changed) && (baseRedByIdOn() || ((sameAsBase(c) || quietAsBase(c)) && !errNamesChanged(c))) && (c.ids ?? []).every((i) => !block.has(i) && (shownIds.has(i) || !changed.some((f) => idNamesFile(i, f))) && !goIdTouched(repoDir, i, changed)), base: new Set(ids(c.cmd)) })), known.size);
  const rust = (cargoTouched(changed) ? bad : []).map((c) => `NOT PROVEN: ${c.name} may run cargo tests and the diff edits Rust source or a manifest; cargo test ids carry no crate path, so a failure cannot be shown pre-existing`);
  const red = res.preExistingChecks.length ? bad.filter((c) => res.preExistingChecks.includes(c.name) && massive(c.cmd)) : [], redLine = red.map((c) => `NOT PROVEN: suite red at base (${of(c.cmd)!.failing_ids.length} failing ids) for "${c.cmd}": it is compared per id, never blocks and proves nothing about this change`).join("; ");
  if (redLine) res.line = [res.line, redLine].filter(Boolean).join("; ");
  const flakyOnly = bad.filter((c) => res.preExistingChecks.includes(c.name)).flatMap((c) => { const b = of(c.cmd), base = new Set(b?.failing_ids ?? []), hit = comparableIds(c.ids ?? []).filter((i) => (b?.flaky_ids ?? []).includes(i) && !base.has(i)); return hit.length ? [`NOT PROVEN: "${c.cmd}" was excused with ${hit.length} id(s) that fail on only some base passes (flaky), e.g. ${hit[0]}; the change was not shown to leave them alone`] : []; }).join("; ");
  if (flakyOnly) res.line = [res.line, flakyOnly].filter(Boolean).join("; ");
  const silentLine = bad.filter((c) => res.preExistingChecks.includes(c.name) && sameAsBase(c) && silentOf(c).silent > 0).map((c) => `${silentOf(c).silent} test(s) of "${c.cmd}" ${SILENT_IDS_NOTE}`).join("; "); // SILENT-IDS disclosure: a plain line on the receipt's baseline, not a NOT PROVEN
  if (silentLine) res.line = [res.line, silentLine].filter(Boolean).join("; ");
  const quiet = bad.filter((c) => res.preExistingChecks.includes(c.name) && !sameAsBase(c)).map((c) => `NOT PROVEN: "${c.cmd}" was excused as red on base although its error text differs from base (by noise only: the same error shapes); no changed file or symbol appears in any failure`).join("; ");
  if (quiet) res.line = [res.line, quiet].filter(Boolean).join("; ");
  if (!unproven.length && !rust.length) return res;
  const np = [...unproven.map((u) => `NOT PROVEN: package ${u} did not build on base or head; its tests ran on neither`), ...rust].join("; ");
  return { ...res, line: [res.line, np].filter(Boolean).join("; ") };
}

/** One line per failing full-suite check that attributeFullSuite did not excuse, saying which rule kept it blocking (so a receipt never shows an unexplained red suite).
 *  Same inputs and the same profile as attributeFullSuite; `excused` is its preExistingChecks. */
/** TOUCHED-BASE-RED (LOKI_E10_TOUCHED_BASE_RED, default on, =0 opts out): a test file the diff edited is red on base by every failing id when each comparable
 *  failing id is red in the intake profile of exactly this base commit (any attributable, complete run) with the same error lines (sameErrors), and no
 *  failing id is a case the diff added or whose body it edited (`editedTitles`). FireLater#24: one assertion was added to Sidebar.test.tsx, whose 19 tests
 *  were already red; after the edit the same 19 failed and the added case passed. A previously green id that now fails, a new error under an old id, a
 *  failing added or edited case, a missing or other-commit profile, or a check with no parsed ids or errors is never excused. */
export const touchedBaseRedOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_TOUCHED_BASE_RED"] ?? "").trim());
export function touchedRedOnBase(repoDir: string, baseSha: string, c: { ids?: string[]; errors?: Map<string, string[]> }, editedTitles: readonly string[]): boolean {
  if (!touchedBaseRedOn()) return false;
  const p = loadProfile(repoDir); if (!p || p.revision !== baseSha) return false;
  const ids = comparableIds(c.ids ?? []); if (ids.length === 0 || !c.errors) return false;
  if (ids.some((i) => editedTitles.some((t) => t.length > 0 && (i === t || i.endsWith(` > ${t}`))))) return false;
  return redOnBaseProfile(p, ids, c.errors);
}
/** Every comparable id is red in an attributable, complete run of the profile with the same error lines (sameErrors). */
function redOnBaseProfile(p: CommandProfile, ids: readonly string[], errors: Map<string, string[]>, textOnly = false): boolean {
  const runs = [p.baseline, ...(p.suites ?? [])].filter((b) => b.ran && b.attributable && !b.timed_out && b.reason !== "baseline budget used up");
  const baseIds = new Set(runs.flatMap((b) => b.failing_ids)), baseErr = new Map<string, string[]>();
  for (const b of runs) for (const [k, v] of Object.entries(b.failing_errors ?? {})) if (!baseErr.has(k)) baseErr.set(k, v);
  return ids.length > 0 && ids.every((i) => baseIds.has(i) || [...baseIds].some((b) => b.endsWith(` > ${i}`))) && ((!textOnly && baseRedByIdOn()) || sameErrors(errors, baseErr, [...ids])); // the same error lines as base, never ids alone (ids alone only under the unsafe LOKI_E10_BASE_RED_BY_ID=1). errorsById keeps a failure's message line, so a stack frame whose line number moved is not a difference: on the recorded FireLater#24 run 1e48 the edited Header.test.tsx repeats all 24 base lines
}
/** COLLATERAL-BASELINE (LOKI_E10_COLLATERAL_BASELINE, default on, =0 opts out): a collateral check (a relevant test that is not the task's own) is pre-existing at once,
 *  with no COLLATERAL_RED cap and no fix round, only when its test file is unedited and every comparable failing id with its error lines equals this base commit's
 *  intake profile (redOnBaseProfile). A new failing id, or the same id with another error (with or without a changed paired source), keeps the cap. */
export const collateralBaselineOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_COLLATERAL_BASELINE"] ?? "").trim());
export function collateralOnBaseline(repoDir: string, baseSha: string, test: string, c: { ids?: string[]; errors?: Map<string, string[]> }, changed: readonly string[], stem: string): boolean {
  if (!collateralBaselineOn() || changed.includes(test)) return false;
  const td = test.includes("/") ? test.slice(0, test.lastIndexOf("/")) : ".", sd = /(?:^|\/)(?:__tests__|tests|test)$/.test(td) ? (td.includes("/") ? td.slice(0, td.lastIndexOf("/")) : ".") : td;
  // A changed paired source (x/page.ts beside x/__tests__/page.test.ts) is the likeliest way for the change to alter this test's failure, so with one the
  // excuse is taken from the error text alone and never from ids (not even under LOKI_E10_BASE_RED_BY_ID=1): every failing id must repeat its base error
  // lines. Until 2026-11-17 a changed paired source capped the test whatever its error; a run was reported to end in a spec conflict on it (its error
  // lines were not kept, so that is not measured). The stem is compared with case: "Header" (Header.test.tsx) does not pair with header.tsx.
  const paired = changed.some((f) => { const fd = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "."; return (fd === sd || fd === td) && f.slice(f.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") === stem; });
  const p = loadProfile(repoDir); if (!p || p.revision !== baseSha || !c.errors) return false;
  return redOnBaseProfile(p, comparableIds(c.ids ?? []), c.errors, paired);
}
export const TOUCHED_RED = "edited test file red on base by every failing id with the same errors; the cases the change added or edited pass (excused, not blocking)";
export function whyFullSuiteNotExcused(repoDir: string, baseSha: string, full: FullCheck[], changed: string[], excused: string[], blocked: readonly string[] = [], shownIds: ReadonlySet<string> = new Set()): string[] {
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
    const known = new Set([...b.failing_ids, ...(b.flaky_ids ?? [])]), fresh = comparableIds(c.ids).filter((i) => !known.has(i)), inChanged = c.ids.filter((i) => (!shownIds.has(i) && changed.some((f) => idNamesFile(i, f))) || goIdTouched(repoDir, i, changed)); // ID-PKG-RELATIVE: the same rule attributeFullSuite uses
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
  else if (b.reason === BASE_DEFERRED) { /* RW-01: not measured yet by design (a multi-package repository), neither a gap nor a credit */ }
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
