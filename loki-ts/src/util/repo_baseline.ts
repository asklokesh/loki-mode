// loki-ts/src/util/repo_baseline.ts -- REPOMEM: the repo's build/test/lint/typecheck commands and a baseline test run on the
// untouched tree, persisted to .loki/state/repo-profile.json so the user never explains how the repo works twice. Discovery reads
// manifests only (package.json, Makefile, pyproject/tox/pytest.ini, go.mod, Cargo.toml, CI workflows, read-only); the one executed
// command is the test command, on the pristine base tree, so a later failure is attributable: pre-existing (in the baseline) or introduced.
// Reused while the manifest hash matches; the baseline alone is re-run when HEAD moved. Never throws into the caller: no profile is a valid state.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failIds } from "../engine10/failures.ts";
import { plainTestEnv, stripAnsi } from "./check_result.ts";
import { safeGit } from "./safe_git.ts";

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
export interface RepoProfile {
  version: 1;
  revision: string; // git HEAD the baseline ran on
  manifest_hash: string;
  created_at: string;
  commands: ProfileCommand[];
  baseline: { ran: boolean; command: string | null; exit_code: number | null; duration_s: number | null; timed_out: boolean; failing_ids: string[]; attributable: boolean; reason?: string };
}
export interface BaselineRun { code: number | null; timedOut: boolean; out: string; missing?: boolean }
export type BaselineRunner = (cmd: string, cwd: string, timeoutMs: number) => BaselineRun;

export const profilePath = (repoDir: string): string => join(repoDir, ".loki", "state", "repo-profile.json");
const DEFAULT_TIMEOUT_S = 60;
const MANIFESTS = ["package.json", "Makefile", "makefile", "GNUmakefile", "pyproject.toml", "tox.ini", "pytest.ini", "setup.cfg", "go.mod", "Cargo.toml"];
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
export function runBaseline(repoDir: string, commands: ProfileCommand[], opts: BuildOpts = {}): RepoProfile["baseline"] {
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

export function loadProfile(repoDir: string): RepoProfile | null {
  try { const p = JSON.parse(readFileSync(profilePath(repoDir), "utf8")) as RepoProfile; return p?.version === 1 && Array.isArray(p.commands) && p.baseline ? p : null; } catch { return null; }
}
function save(repoDir: string, p: RepoProfile): void {
  const path = profilePath(repoDir), tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(join(repoDir, ".loki", "state"), { recursive: true });
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n"); renameSync(tmp, path);
}
const headOf = (repoDir: string): string => { try { return safeGit(repoDir, ["rev-parse", "HEAD"]).trim(); } catch { return ""; } };

/** The one entry point (intake). Same manifest hash and HEAD: reuse. Same hash, new HEAD: keep the commands, re-run only the baseline. New hash: rediscover and re-baseline. */
export function ensureProfile(repoDir: string, opts: BuildOpts = {}): { profile: RepoProfile; reused: boolean } | null {
  try {
    const hash = manifestHash(repoDir), rev = headOf(repoDir), old = loadProfile(repoDir);
    if (old && old.manifest_hash === hash && old.revision === rev) return { profile: old, reused: true };
    const commands = old && old.manifest_hash === hash ? old.commands.map((c) => ({ ...c, ...(c.kind === "test" ? { validated: null, exit_code: null, duration_s: null, failing_ids: [] } : {}) })) : discoverCommands(repoDir);
    const profile: RepoProfile = { version: 1, revision: rev, manifest_hash: hash, created_at: (opts.now?.() ?? new Date()).toISOString(), commands, baseline: runBaseline(repoDir, commands, opts) };
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

/** Stable text for the implementer brief: fixed order, no timestamps, so the bytes change only when the profile's content does. */
export function profileBrief(repoDir: string): string {
  const p = loadProfile(repoDir);
  if (!p || p.commands.length === 0) return "";
  const lines = (["test", "lint", "typecheck", "build"] as const).flatMap((k) => p.commands.filter((c) => c.kind === k).map((c) => `${k}: ${c.cmd}${c.validated === true ? " (validated on the untouched tree)" : c.validated === false ? " (could not run)" : ""}`));
  const base = p.baseline.attributable && p.baseline.failing_ids.length ? `Tests already failing before your change (not yours, do not fix): ${p.baseline.failing_ids.slice(0, 20).join("; ")}.` : "";
  return ["Repo commands (from the repo's manifests, do not rediscover):", ...lines, ...(base ? [base] : [])].join("\n");
}

export function renderProfile(p: RepoProfile | null): string {
  if (!p) return "repo profile: none yet (built on the first `loki start` in this repo)\n";
  const rows = p.commands.map((c) => `  ${c.kind.padEnd(9)} ${c.cmd}  [${c.source}]  ${c.validated === true ? `validated exit=${c.exit_code} ${c.duration_s}s` : c.validated === false ? `not runnable${c.note ? `: ${c.note}` : ""}` : "not executed"}`);
  const b = p.baseline;
  const bl = b.ran ? `${b.command} exit=${b.exit_code}${b.timed_out ? " (timed out)" : ""}, ${b.failing_ids.length} failing id(s)${b.attributable ? "" : `, not attributable${b.reason ? ` (${b.reason})` : ""}`}` : `not run (${b.reason ?? "unknown"})`;
  return [".loki/state/repo-profile.json", `  revision ${p.revision.slice(0, 12)}  manifest ${p.manifest_hash.slice(0, 12)}  built ${p.created_at}`, ...rows, `  baseline: ${bl}`].join("\n") + "\n";
}
