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
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, isAbsolute } from "node:path";
import { failIds } from "../engine10/failures.ts";
import { plainTestEnv, stripAnsi } from "../util/check_result.ts";
import { safeGit } from "../util/safe_git.ts";
import { lokiDir } from "../util/paths.ts";
import { atomicWriteFileSync } from "./state.ts";

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
export function buildProfile(opts: BuildProfileOpts): RepoProfile {
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
    facts,
  };
  const target = profilePath(opts.lokiDirOverride);
  mkdirSync(resolve(target, ".."), { recursive: true });
  atomicWriteFileSync(target, JSON.stringify(profile, null, 2) + "\n");
  return profile;
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
}
export interface CommandProfile {
  version: 1;
  revision: string; // git HEAD the baseline ran on
  manifest_hash: string;
  created_at: string;
  commands: ProfileCommand[];
  baseline: { ran: boolean; command: string | null; exit_code: number | null; duration_s: number | null; timed_out: boolean; failing_ids: string[]; attributable: boolean; reason?: string };
}
export interface BaselineRun { code: number | null; timedOut: boolean; out: string; missing?: boolean }
export type BaselineRunner = (cmd: string, cwd: string, timeoutMs: number) => BaselineRun;

export const commandProfilePath = (repoDir: string): string => join(repoDir, ".loki", "state", "repo-profile.json");
const DEFAULT_TIMEOUT_S = 60;
const MANIFESTS = ["requirements.txt", "package.json", "Makefile", "makefile", "GNUmakefile", "pyproject.toml", "tox.ini", "pytest.ini", "setup.cfg", "go.mod", "Cargo.toml"];
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
export function discoverCommands(repoDir: string): ProfileCommand[] {
  const out: ProfileCommand[] = [];
  const pj = read(join(repoDir, "package.json"));
  if (pj) {
    let scripts: Record<string, unknown> = {};
    try { scripts = (JSON.parse(pj) as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { /* malformed manifest: nothing to discover */ }
    const pm = pkgManager(repoDir), run = (n: string): string => (n === "test" ? `${pm} test` : `${pm} run ${n}`);
    const has = (n: string): boolean => typeof scripts[n] === "string" && !(n === "test" && NO_TEST.test(String(scripts[n])));
    const pick = (kind: CmdKind, names: string[]): void => { const n = names.find(has); if (n) out.push(entry(kind, run(n), "package.json")); };
    pick("test", ["test"]); pick("lint", ["lint"]); pick("typecheck", ["typecheck", "type-check", "tsc"]); pick("build", ["build"]);
  }
  const mk = ["Makefile", "makefile", "GNUmakefile"].map((f) => [f, read(join(repoDir, f))] as const).find(([, t]) => t);
  if (mk) {
    const targets = new Set([...mk[1].matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]!));
    const pick = (kind: CmdKind, names: string[]): void => { const n = names.find((x) => targets.has(x)); if (n) out.push(entry(kind, `make ${n}`, mk[0])); };
    pick("test", ["test", "check"]); pick("lint", ["lint"]); pick("typecheck", ["typecheck", "mypy"]); pick("build", ["build", "all"]);
  }
  const pyTxt = ["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg"].map((f) => [f, read(join(repoDir, f))] as const).filter(([, t]) => t);
  const pyPytest = pyTxt.find(([f, t]) => f === "pytest.ini" || /\[tool\.pytest|\[tool:pytest\]|\[pytest\]/.test(t)) ?? (existsSync(join(repoDir, "conftest.py")) ? (["conftest.py", ""] as const) : undefined);
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

/** Default runner: `sh -c` in repoDir, an explicit scoped env (token-free, no color, no bytecode litter), SIGKILL on timeout. */
export const shellRunner: BaselineRunner = (cmd, cwd, timeoutMs) => {
  const r = spawnSync("sh", ["-c", cmd], { cwd, env: { ...plainTestEnv(), PYTHONDONTWRITEBYTECODE: "1", CI: "1" }, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (r.status === null && r.signal === "SIGKILL");
  return { code: r.status, timedOut, out: stripAnsi(`${r.stdout ?? ""}\n${r.stderr ?? ""}`), missing: r.status === 127 };
};
const untracked = (repoDir: string): string[] => { try { return safeGit(repoDir, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((l) => l.trim()).filter(Boolean); } catch { return []; } };

export interface BuildOpts { run?: BaselineRunner; timeoutS?: number; now?: () => Date }
/** Runs the first test command once on the tree as it is, records it on the command, and removes any untracked file the run itself created (the diff must stay the agent's). */
export function runBaseline(repoDir: string, commands: ProfileCommand[], opts: BuildOpts = {}): CommandProfile["baseline"] {
  const t = commands.find((c) => c.kind === "test");
  if (!t) return { ran: false, command: null, exit_code: null, duration_s: null, timed_out: false, failing_ids: [], attributable: false, reason: "no test command discovered" };
  const before = new Set(untracked(repoDir)), started = Date.now(), tmo = opts.timeoutS ?? DEFAULT_TIMEOUT_S;
  const r = (opts.run ?? shellRunner)(t.cmd, repoDir, tmo * 1000);
  const dur = Math.round((Date.now() - started) / 100) / 10;
  for (const f of untracked(repoDir)) if (!before.has(f)) rmSync(join(repoDir, f), { force: true, recursive: true });
  const ids = r.code !== 0 && !r.timedOut ? failIds(r.out) : [];
  t.validated = !r.timedOut && !r.missing && r.code !== null; t.exit_code = r.code; t.duration_s = dur; t.failing_ids = ids;
  if (r.timedOut) t.note = `timed out after ${tmo}s; no baseline`; else if (r.missing) t.note = "command not found";
  const attributable = t.validated === true && (r.code === 0 || ids.length > 0);
  const reason = attributable ? undefined : r.timedOut ? "timed out" : r.missing ? "command not found" : "failing test ids not parseable, failures cannot be attributed";
  return { ran: true, command: t.cmd, exit_code: r.code, duration_s: dur, timed_out: r.timedOut, failing_ids: ids, attributable, ...(reason ? { reason } : {}) };
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
    if (old && old.manifest_hash === hash && old.revision === rev) return { profile: old, reused: true };
    const commands = old && old.manifest_hash === hash ? old.commands.map((c) => ({ ...c, ...(c.kind === "test" ? { validated: null, exit_code: null, duration_s: null, failing_ids: [] } : {}) })) : discoverCommands(repoDir);
    const profile: CommandProfile = { version: 1, revision: rev, manifest_hash: hash, created_at: (opts.now?.() ?? new Date()).toISOString(), commands, baseline: runBaseline(repoDir, commands, opts) };
    save(repoDir, profile);
    return { profile, reused: false };
  } catch { return null; }
}

/** Failing checks split by the baseline. A check is pre-existing only when the profile ran on exactly this base commit, the baseline was attributable,
 *  `eligible` (the caller: untouched, non-target test) and EVERY failing id of the check is in the baseline (one new id makes it introduced).
 *  A check without parsed ids is introduced: unknown never excuses a failure. */
export interface Attribution { preExistingChecks: string[]; preExistingIds: string[]; introducedChecks: string[]; line: string | null }
export function attribute(repoDir: string, baseSha: string, failing: { name: string; ids?: string[]; eligible: boolean }[]): Attribution {
  const p = loadProfile(repoDir), none: Attribution = { preExistingChecks: [], preExistingIds: [], introducedChecks: failing.map((f) => f.name), line: null };
  if (!p || p.revision !== baseSha || !p.baseline.attributable || p.baseline.failing_ids.length === 0 || failing.length === 0) return none;
  const base = new Set(p.baseline.failing_ids), pre = failing.filter((f) => f.eligible && f.ids?.length && f.ids.every((i) => base.has(i)));
  const introduced = failing.filter((f) => !pre.includes(f)).map((f) => f.name);
  if (pre.length === 0) return { ...none, line: `baseline: ${base.size} known failure(s) before this run; none of the failing checks match them, ${introduced.length} introduced (blocking)` };
  return { preExistingChecks: pre.map((f) => f.name), preExistingIds: pre.flatMap((f) => f.ids ?? []), introducedChecks: introduced,
    line: `baseline: ${pre.length} pre-existing failing check(s) (not blocking), ${introduced.length} introduced${introduced.length ? " (blocking)" : ""}` };
}

/** REPOMEM for the RISKTIER full suite: the same `attribute`, fed the ids the REAL run's check carries (`ids`, from failIds). Nothing is re-run.
 *  Fail-closed: the baseline must have run this same command (else the ids are not comparable and nothing is excused, the reason is returned in `line`),
 *  ids must be present and complete (failIds gives [] on partial extraction), and an id the targeted checks already failed (`blocked`) or one naming a changed file is never excused. */
export function attributeFullSuite(repoDir: string, baseSha: string, full: { name: string; cmd: string; result: string; ids?: string[] }[], blocked: string[], changed: string[]): Attribution {
  const bad = full.filter((c) => c.result === "fail"), none: Attribution = { preExistingChecks: [], preExistingIds: [], introducedChecks: bad.map((c) => c.name), line: null };
  const norm = (s: string): string => s.replace(/\s+--silent\b/, "").trim(), p = loadProfile(repoDir);
  if (!bad.length || !p || p.revision !== baseSha || !p.baseline.attributable || !p.baseline.failing_ids.length) return none;
  if (bad.some((c) => norm(c.cmd) !== norm(p.baseline.command ?? ""))) return { ...none, line: `baseline: ran "${p.baseline.command}", not the full suite command, ids not comparable, full suite failures not excused` };
  const block = new Set(blocked);
  return attribute(repoDir, baseSha, bad.map((c) => ({ name: c.name, ...(c.ids ? { ids: c.ids } : {}), eligible: (c.ids ?? []).every((i) => !block.has(i) && !changed.some((f) => i.includes(f))) })));
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
export function repoReadiness(p: CommandProfile, host?: ReadinessHost): Readiness {
  const findings: ReadinessFinding[] = [];
  let score = 100;
  const add = (cost: number, f: ReadinessFinding): void => { score -= cost; findings.push(f); };
  const has = (k: CmdKind): boolean => p.commands.some((c) => c.kind === k);
  const b = p.baseline;
  if (!has("test")) add(30, { id: "no-test-command", severity: "high", message: "No test command found in the repo manifests.", fix: "Add a test script (for example `npm run test`, `pytest`, `go test ./...`) so changes can be verified." });
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

export const readinessLines = (r: Readiness): string[] => [`  Readiness: ${r.score}/100 (${r.grade})`, ...(r.findings.length ? ["  Fix:", ...r.findings.map((f) => `    - ${f.fix}`)] : [])];

export function renderProfile(p: CommandProfile | null, host?: ReadinessHost): string {
  if (!p) return "repo profile: none yet (run `loki doctor --repo` to build it; LOKI_REPO_BASELINE=0 disables building)\n";
  const rows = p.commands.map((c) => `  ${c.kind.padEnd(9)} ${c.cmd}  [${c.source}]  ${c.validated === true ? `validated exit=${c.exit_code} ${c.duration_s}s` : c.validated === false ? `not runnable${c.note ? `: ${c.note}` : ""}` : "not executed"}`);
  const b = p.baseline;
  const bl = b.ran ? `${b.command} exit=${b.exit_code}${b.timed_out ? " (timed out)" : ""}, ${b.failing_ids.length} failing id(s)${b.attributable ? "" : `, not attributable${b.reason ? ` (${b.reason})` : ""}`}` : `not run (${b.reason ?? "unknown"})`;
  return [".loki/state/repo-profile.json", `  revision ${p.revision.slice(0, 12)}  manifest ${p.manifest_hash.slice(0, 12)}  built ${p.created_at}`, ...rows, `  baseline: ${bl}`, ...readinessLines(repoReadiness(p, host))].join("\n") + "\n";
}
