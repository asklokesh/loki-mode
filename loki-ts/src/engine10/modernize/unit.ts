// loki-ts/src/engine10/modernize/unit.ts -- M-15: unit runner, card to v10 run with oracle Wall
// and equiv check (docs/v10/MODERNIZE.md section 3.4 "Execute in parallel"). Depends on M-13
// (equiv.ts), M-14 (presealed_wall.ts).
//
// Binding requirements (BOARD.md M-15 notes, M-13/M-14 opus reviews, D42 (3)/(4)):
// (1) sealOracle runs with the card's normalizers BEFORE any implementation exists for the unit.
//     runUnit below calls oracle/seal.ts's sealOracle as its very first step, strictly before the
//     injected `implement` callback -- see runUnit's ordering comment and unit.test.ts's ordering
//     test, which fails an `implement` that runs before the oracle.captured/oracle.flagged event
//     exists in the modernize log.
// (2) verifySeal and verifyPreSealedWall are called before trusting an oracle or a Wall. Both
//     M-13's checkEquivalence and M-14's sealPreSealedWall already call verifySeal internally
//     (never take a caller's word for a seal); runUnit additionally calls verifyPreSealedWall
//     itself, right after sealing the Wall and again before ever calling `implement` or
//     checkEquivalence, so a Wall this run just sealed (or one left over from a crashed resume)
//     is re-checked from disk/log, never trusted from a return value alone.
// (3) The base-run parsing M-14 consumes -- runner, exit code, failedCount -- is this file's job
//     (presealed_wall.ts's own header: "shelling out ... under the target runtime is the unit
//     runner's job (M-15)"). parsePytestOutput below parses real pytest stdout into a
//     presealed_wall.ts BaseRunOutcome, failing closed (no summary line, no parsed integer) on
//     garbled or truncated output rather than guessing.
// (4) A pytest collection error (exit 2) is classified by presealed_wall.ts's classifyBaseRun from
//     the raw output, using the Wall's own rule (pytestCollectionIsRed, imported from stages/wall.ts): no
//     second classifier lives in this file.
// (5) MODERNIZE.md:153/262 no-op ablation: an injected stub runner replaces the new unit with stubs;
//     the oracle cases must then FAIL equivalence, else NOT_PROVEN "oracle does not constrain unit".
// (6) Conformance files (tests, conftest.py, pytest config) and every .py are hashed at Wall-seal time and must be
//     unchanged on the new tree before the post-implement conformance run is trusted.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import type { EquivNormalizers, SealedOracle } from "./oracle/seal.ts";
import { sealOracle, verifySeal } from "./oracle/seal.ts";
import type { BaseConformanceRunner, BaseRunOutcome, PreSealedWallResult } from "./presealed_wall.ts";
import { classifyBaseRun, sealPreSealedWall, verifyPreSealedWall } from "./presealed_wall.ts";
import type { EquivResult, NewCaseRunner } from "./equiv.ts";
import { checkEquivalence } from "./equiv.ts";
import { oracleDir } from "./types.ts";
import type { ModernizeTarget } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// (3)/(4): real pytest output parsing.
// ---------------------------------------------------------------------------------------------

/** pytest's own summary footer, e.g. "=== 2 failed, 5 passed in 0.31s ===". Matched only as the
 *  LAST such line in the output (pytest can print progress lines mid-run that are not the
 *  footer), and only "failed" is trusted -- any other shape (no footer at all, a footer with no
 *  "failed" clause) returns undefined rather than a guess, per D42 (3)'s fail-closed rule. */
const SUMMARY_RE = /^=+\s(.*)\sin\s[\d.]+s(?:\s\(\d+:\d+:\d+\))?\s=+$/;

function parseFailedCount(stdout: string): number | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    const m = SUMMARY_RE.exec(line);
    if (!m) continue;
    const fm = /(\d+)\s+failed\b/.exec(m[1] ?? "");
    if (!fm) return undefined; // a real footer with no "failed" clause: nothing failed, or garbled
    const n = Number(fm[1]);
    return Number.isInteger(n) && n >= 1 ? n : undefined;
  }
  return undefined; // no footer found at all: truncated output, never guessed at
}

/** Parses one pytest run's raw stdout into presealed_wall.ts's BaseRunOutcome. Pure and
 *  hermetic -- the actual `spawnSync` call lives in makePytestBaseRunner below, so this is
 *  directly testable against captured real pytest output (unit.test.ts). Fails closed by
 *  construction: exit 0/timeout/signal/126/127/3/4/5 need no extra parsing (classifyBaseRun
 *  handles them from exitCode/timedOut alone); exit 1 gets a failedCount only when a real
 *  footer line parses; exit 2 gets a collectionError only when (4) above resolves one. */
export function parsePytestOutput(
  repoDir: string,
  stdout: string,
  exitCode: number | null,
  timedOut: boolean,
): BaseRunOutcome {
  const outcome: BaseRunOutcome = { runner: "pytest", exitCode, timedOut };
  if (timedOut || exitCode === null) return outcome;
  // exit 2: hand the raw output to classifyBaseRun, which reuses the Wall's own red/not_run rule.
  if (exitCode === 2) return { ...outcome, output: stdout };
  if (exitCode === 1) {
    const failedCount = parseFailedCount(stdout);
    return failedCount !== undefined ? { ...outcome, failedCount } : outcome;
  }
  return outcome;
}

/** The real conformance runner: shells out to `<pythonBin> -m pytest` in repoDir, under whatever
 *  interpreter the target runtime resolves to on PATH (section 7: "the Wall runs under the target
 *  runtime"), and parses its output with parsePytestOutput above. A spawn that cannot even start
 *  (ENOENT: the interpreter is missing) reports exitCode null, timedOut false -- classifyBaseRun
 *  already treats a null exitCode as not_run, never red. `timeoutMs` bounds a hung run the same
 *  way spawnSync's own `timeout` option does (SIGTERM, then a null exitCode). */
export function makePytestBaseRunner(pythonBin = "python3", timeoutMs = 300_000): BaseConformanceRunner {
  return (_unit: string, repoDir: string): BaseRunOutcome => {
    // Bytecode must never answer for source: no in-tree .pyc is read (fresh empty PYTHONPYCACHEPREFIX)
    // or written (PYTHONDONTWRITEBYTECODE), and pytest's own cache plugin is off.
    const pycPrefix = mkdtempSync(join(tmpdir(), "loki-pyc-"));
    let res;
    try {
      res = spawnSync(pythonBin, ["-m", "pytest", "-p", "no:cacheprovider"], {
        cwd: repoDir, encoding: "utf8", timeout: timeoutMs,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: pycPrefix },
      });
    } finally { rmSync(pycPrefix, { recursive: true, force: true }); }
    const timedOut = res.signal === "SIGTERM" && res.status === null;
    // pytest's own report (the footer, the collection-error traceback) goes to stdout; stderr is
    // never appended ahead of it -- an unrelated stderr line (a warning, a plugin's own output)
    // must never shadow or precede the real footer this file's parser searches for.
    return parsePytestOutput(repoDir, `${res.stdout ?? ""}\n${res.stderr ?? ""}`, res.status, timedOut);
  };
}

// ---------------------------------------------------------------------------------------------
// (6): conformance-file binding.
// ---------------------------------------------------------------------------------------------
const CONF_EVENT = "unit.conformance_sealed";
const SKIP_DIRS = new Set([".git", ".loki", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".tox"]);
const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
// Anything that can change what `python -m pytest` runs or reports; a NEW one is refused, not just a changed one.
const PYTEST_CFG = /(^|\/)(conftest\.py|\.?pytest\.(ini|toml)|pytest\.py|pyproject\.toml|setup\.cfg|tox\.ini|sitecustomize\.py|usercustomize\.py)$|\.pth$|(^|\/)pytest\//;

/** Deletes every __pycache__ under dir (skipping SKIP_DIRS, never following a symlink), so stale or
 *  planted bytecode cannot stand in for a hashed .py. */
export function purgePycache(dir: string): void {
  const walk = (d: string): void => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue; // a symlink is not a directory entry here
      const full = join(d, e.name);
      if (e.name === "__pycache__") rmSync(full, { recursive: true, force: true });
      else if (!SKIP_DIRS.has(e.name)) walk(full);
    }
  };
  walk(dir);
}

const LINK = "symlink:";
// Skipped dirs still contribute files whose NAME can steer pytest or the interpreter (a conftest.py in
// node_modules/venv/.tox): they are hashed, so a sealed-name file added there is drift. VCS and run state are fully skipped.
const FULL_SKIP = new Set([".git", ".loki"]);

/** Digest of what a link points at, for links resolving outside `dir` (inside, the target is hashed under its own path).
 *  Files hash their bytes; directories hash names plus file bytes (nested links by target string); capped, fail closed. */
function outsideTargetDigest(dir: string, full: string): string {
  let real: string;
  try { real = realpathSync(full); } catch { return "dangling"; }
  let root: string;
  try { root = realpathSync(dir); } catch { return "noroot"; }
  if (real === root || real.startsWith(root + sep)) return "inside";
  const h = createHash("sha256");
  let budget = 20_000;
  const walk = (p: string): void => {
    if (budget-- <= 0) { h.update("capped"); return; }
    let st;
    try { st = lstatSync(p); } catch { h.update("unreadable"); return; }
    if (st.isSymbolicLink()) { try { h.update("L" + readlinkSync(p)); } catch { h.update("L?"); } return; }
    if (st.isDirectory()) {
      let names: string[] = [];
      try { names = readdirSync(p).sort(); } catch { h.update("unreadable"); }
      for (const n of names) { h.update("D" + n); walk(join(p, n)); }
      return;
    }
    if (st.isFile()) { try { h.update(readFileSync(p)); } catch { h.update("unreadable"); } }
  };
  walk(real);
  return h.digest("hex");
}

/** sha256 of EVERY regular file under dir (bytes, so fixtures, snapshots and golden data are bound),
 *  keyed by relative path; pyproject.toml, setup.cfg and tox.ini are hashed in full. SKIP_DIRS (venvs,
 *  caches, node_modules) contribute only files whose name is sealed (test files, conftest.py, pytest
 *  config, *.pth, sitecustomize.py). A symlink is never followed: it is recorded as
 *  "symlink:<target>|<digest>" where the digest covers the target bytes when the link resolves outside dir. */
export function conformanceHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rels: string[] = [];
  const walk = (sub: string, inSkip: boolean): void => {
    let ents;
    try { ents = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (FULL_SKIP.has(e.name)) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      const skipped = inSkip || SKIP_DIRS.has(e.name);
      if (e.isDirectory()) {
        if (!skipped) rels.push(rel);
        walk(rel, skipped); // a symlinked dir is recorded as a link, never descended
      } else if (!skipped || TEST_FILE.test(rel) || PYTEST_CFG.test(rel)) {
        rels.push(rel);
      }
    }
  };
  walk("", false);
  for (const rel of rels) {
    let data: Buffer;
    try {
      const st = lstatSync(join(dir, rel));
      if (st.isSymbolicLink()) {
        out[rel] = `${LINK}${readlinkSync(join(dir, rel))}|${outsideTargetDigest(dir, join(dir, rel))}`;
        continue;
      }
      if (!st.isFile()) continue;
      data = readFileSync(join(dir, rel));
    } catch { continue; }
    out[rel] = createHash("sha256").update(data).digest("hex");
  }
  return out;
}

/** Top-level module/package names under `names` that Python resolves OUTSIDE the repo (stdlib or the
 *  target runtime's site-packages). Run from a neutral cwd in isolated mode so the repo cannot answer. */
function importableOutsideRepo(target: string, names: string[]): Set<string> {
  if (names.length === 0) return new Set();
  const code = "import sys,importlib.util as u\nfor n in sys.argv[1:]:\n    try:\n        if n in sys.stdlib_module_names or u.find_spec(n): print(n)\n    except Exception: print(n)\n";
  const r = spawnSync(target, ["-I", "-c", code, ...names], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 });
  // fail closed: if the probe cannot run, every name counts as shadowing
  return r.status === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : new Set(names);
}

/** First way `now` departs from the sealed `base` set, or null: a sealed test/config file changed or
 *  removed; a test file or config-class file (conftest.py, pytest config, pytest shim, sitecustomize/
 *  usercustomize, .pth) the base never had; or a .py outside the card's `files` changed, removed or added.
 *  Without `files`, only the importable-outside-repo fallback applies to added modules (a changed
 *  existing module cannot be told apart from the unit's own code). */
function conformanceDrift(base: Record<string, string>, now: Record<string, string>, files: string[] | undefined, target: string): string | null {
  const sealed = (p: string): boolean => TEST_FILE.test(p) || PYTEST_CFG.test(p);
  const listed = (p: string): boolean => !!files?.some((f) => p === f || p.startsWith(f.replace(/\/?$/, "/")));
  const link = (h: string | undefined): boolean => !!h?.startsWith(LINK);
  // Sealed test/config files and any symlink (new or changed, listed or not: pytest follows linked dirs
  // and collects conftest.py inside) are immutable. Otherwise a listed path may change; an unlisted one
  // may not when a file list exists, and without one non-.py data is immutable.
  const immutable = (p: string, linked: boolean): boolean =>
    sealed(p) || linked || (!listed(p) && (!!files || !p.endsWith(".py")));
  for (const [p, h] of Object.entries(base)) {
    if (now[p] === h) continue;
    if (immutable(p, link(h) || link(now[p]))) return `${p} ${p in now ? "changed" : "removed"}`;
  }
  const added = Object.keys(now).filter((p) => !(p in base));
  for (const p of added) if (immutable(p, link(now[p]))) return `${p} added`;
  if (files) return null;
  const tops = [...new Set(added.map((p) => p.split("/")[0]!.replace(/\.py$/, "")))];
  const bad = importableOutsideRepo(target, tops);
  const hit = added.find((p) => bad.has(p.split("/")[0]!.replace(/\.py$/, "")));
  return hit ? `${hit} added (shadows a module importable outside the repo)` : null;
}

// ---------------------------------------------------------------------------------------------
// (1)/(2): card to v10 run orchestration.
// ---------------------------------------------------------------------------------------------

/** One unit's card (section 3.3 plan.json / units/<unit>.md), narrowed to what runUnit needs.
 *  `newTreeDir` defaults to `repoDir` (implementation happens in place) -- per-unit worktree
 *  isolation is the scheduler's job (M-17), not this file's. */
export interface UnitCard {
  unit: string;
  repoDir: string;
  mid: string;
  target: ModernizeTarget;
  normalizers: EquivNormalizers;
  /** The unit's own files (paths or directories, relative to the tree); implement may add or change .py only under these. */
  files?: string[];
  newTreeDir?: string;
  baseSha?: string | null;
}

/** Modernizes one unit in place. Receives the card and must leave `newTreeDir` (repoDir, by
 *  default) with the modernized code before returning. runUnit never calls this until the oracle
 *  is sealed and verified and the pre-sealed Wall is sealed and verified (1)/(2) above. */
export type Implementer = (card: UnitCard) => void;

export interface UnitRunResult {
  unit: string;
  verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
  oracle: SealedOracle | null;
  wall: PreSealedWallResult | null;
  equiv: EquivResult | null;
  not_proven: string[];
}

function notProvenUnitResult(
  unit: string,
  reason: string,
  oracle: SealedOracle | null,
  wall: PreSealedWallResult | null,
): UnitRunResult {
  return { unit, verdict: "NOT_PROVEN", oracle, wall, equiv: null, not_proven: [reason] };
}

function readOracleSealed(repoDir: string, mid: string, unit: string): SealedOracle {
  return JSON.parse(readFileSync(join(oracleDir(repoDir, mid, unit), "sealed.json"), "utf8")) as SealedOracle;
}

/** True once this unit's oracle already has a sealing event, without needing sealOracle's own
 *  throw -- lets runUnit tell "already sealed from a prior/resumed run" apart from any other
 *  sealOracle failure (missing cases.jsonl/coverage.json), which must still surface. */
function oracleAlreadySealed(repoDir: string, mid: string, unit: string): boolean {
  return readModernizeEvents(repoDir, mid).some(
    (e) => (e.type === "oracle.captured" || e.type === "oracle.flagged") && e.data.unit === unit,
  );
}

/** Card to v10 run: seals the oracle, seals and verifies the pre-sealed Wall against the base
 *  tree, only THEN runs the implementation, and finally checks equivalence -- section 3.4/3.5,
 *  D30. Every step that can fail turns into a NOT_PROVEN result rather than a thrown error, same
 *  discipline as equiv.ts's checkEquivalence: "claims stop exactly where equivalence data stops."
 *
 *  Ordering (1): sealOracle is the very first call in this function, strictly before
 *  `implement(card)` -- nothing on any path below reaches `implement` before it.
 *  Trust (2): verifySeal gates whether the just-sealed (or resumed) oracle is trusted at all;
 *  verifyPreSealedWall gates whether the just-sealed (or resumed) Wall is trusted, both re-read
 *  from disk/log rather than taken from a return value. */
export function runUnit(
  card: UnitCard,
  log: ModernizeLog,
  runConformance: BaseConformanceRunner,
  implement: Implementer,
  runNew: NewCaseRunner,
  /** Runs an oracle case against the unit REPLACED BY STUBS (the no-op ablation). Required for PROVEN. */
  runStub?: NewCaseRunner,
): UnitRunResult {
  const { repoDir, mid, unit } = card;
  const newTreeDir = card.newTreeDir ?? repoDir;

  // (1) sealOracle first, unconditionally, before implement is ever reachable below.
  if (!oracleAlreadySealed(repoDir, mid, unit)) {
    try {
      sealOracle(repoDir, mid, unit, log, card.normalizers);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return notProvenUnitResult(unit, `sealOracle failed: ${msg}`, null, null);
    }
  }

  // (2) verifySeal before trusting the oracle for anything downstream.
  const oracleCheck = verifySeal(repoDir, mid, unit);
  if (!oracleCheck.ok) {
    return notProvenUnitResult(unit, `oracle seal invalid: ${oracleCheck.reason ?? "unknown"}`, null, null);
  }
  const oracle = readOracleSealed(repoDir, mid, unit);

  // Pre-sealed Wall: runs the conformance check on the base (unmodernized) tree, still before
  // `implement` -- a green or not_run base refuses the seal outright (section 7, D42 (3)).
  let freshSeal = false;
  try {
    const attempt = sealPreSealedWall(repoDir, mid, unit, card.target, runConformance, log, card.baseSha ?? null);
    if (!attempt.sealed) {
      return notProvenUnitResult(unit, attempt.reason ?? "presealed wall not sealed", oracle, attempt);
    }
    freshSeal = true;
  } catch (e) {
    // Write-once throw: already sealed from a prior/resumed run. verifyPreSealedWall below is the
    // real trust check regardless of why this call produced no fresh seal.
    void e;
  }

  // (2) verifyPreSealedWall before trusting the Wall, whether just sealed above or resumed --
  // never taken from sealPreSealedWall's own return value alone.
  const wallCheck = verifyPreSealedWall(repoDir, mid, unit);
  if (!wallCheck.ok) {
    return notProvenUnitResult(unit, `presealed wall invalid: ${wallCheck.reason ?? "unknown"}`, oracle, null);
  }
  // Read the classification back from the sealing event itself ("wall.presealed.sealed",
  // duplicated here the same way presealed_wall.ts's own file header duplicates D42 (3) from
  // wall.ts, rather than importing an unexported constant) instead of assuming it. sealPreSealedWall
  // only ever writes a seal on "red", so this is always "red" today, but the B2 ablation check
  // below reads it explicitly rather than trusting that invariant silently across a refactor.
  const sealedEvent = readModernizeEvents(repoDir, mid).find(
    (e) => e.type === "wall.presealed.sealed" && e.data.unit === unit,
  );
  const wall: PreSealedWallResult = {
    unit,
    classification: sealedEvent?.data.classification === "red" ? "red" : "not_run",
    sealed: true,
  };

  // (6) Bind the conformance files to the seal: hashed from the pristine base tree, persisted as an
  // event so a resumed run never re-hashes an already modified tree. No record, no PROVEN.
  const bound = readModernizeEvents(repoDir, mid).find((e) => e.type === CONF_EVENT && e.data.unit === unit);
  let sealedHashes = bound?.data.files as Record<string, string> | undefined;
  if (!sealedHashes) {
    if (!freshSeal) return notProvenUnitResult(unit, "conformance files not bound to the seal (no record from seal time)", oracle, wall);
    sealedHashes = conformanceHashes(repoDir);
    log.append(CONF_EVENT, { unit, files: sealedHashes });
  }

  // Only now: the actual code change.
  implement(card);
  purgePycache(newTreeDir);

  const equiv = checkEquivalence(repoDir, mid, unit, newTreeDir, card.normalizers, runNew, log);
  if (equiv.verdict !== "PROVEN") {
    return { unit, verdict: equiv.verdict, oracle, wall, equiv, not_proven: equiv.not_proven };
  }

  // No-op ablation (MODERNIZE.md:153, :262): the oracle cases run against the unit replaced by
  // stubs must FAIL equivalence. A logger that discards keeps this probe out of the unit's receipt.
  if (!runStub) return notProvenUnitResult(unit, "ablation not run", oracle, wall);
  const discard = { append: () => ({}) } as unknown as ModernizeLog;
  const ablation = checkEquivalence(repoDir, mid, unit, newTreeDir, card.normalizers, runStub, discard);
  if (ablation.verdict === "PROVEN") {
    return notProvenUnitResult(unit, "oracle does not constrain unit", oracle, wall);
  }
  if (ablation.verdict !== "NOT_EQUAL") {
    return notProvenUnitResult(unit, `ablation inconclusive: ${ablation.not_proven.join("; ")}`, oracle, wall);
  }
  // Conformance files must be byte-identical to the sealed base (tests, conftest.py, pytest config).
  const drift = conformanceDrift(sealedHashes, conformanceHashes(newTreeDir), card.files, card.target);
  if (drift) return notProvenUnitResult(unit, `conformance files changed since the Wall sealed: ${drift}`, oracle, wall);
  // Target conformance: the same check, re-run against the MODERNIZED tree, must now pass (exit
  // 0 / green) -- a unit whose cases match the oracle but whose target-runtime conformance still
  // fails (or cannot even run) has not actually been modernized.
  purgePycache(newTreeDir);
  const newOutcome = runConformance(unit, newTreeDir);
  const newClassification = classifyBaseRun(newOutcome, newTreeDir);
  if (newClassification !== "green") {
    return notProvenUnitResult(
      unit,
      `target conformance did not pass on the modernized tree (classified ${newClassification})`,
      oracle,
      wall,
    );
  }

  return { unit, verdict: "PROVEN", oracle, wall, equiv, not_proven: [] };
}
