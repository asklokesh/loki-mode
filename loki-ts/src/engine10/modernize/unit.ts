// loki-ts/src/engine10/modernize/unit.ts -- M-15: unit runner, card to v10 run with oracle Wall
// and equiv check (docs/v10/MODERNIZE.md section 3.4 "Execute in parallel"). Depends on M-13
// (equiv.ts), M-14 (presealed_wall.ts).
//
// Binding requirements (BOARD.md M-15 notes, M-13/M-14 opus reviews, D42 (3)/(4)):
// (1) sealOracle runs with the card's normalizers BEFORE any implementation exists: it is runUnit's
//     very first step, strictly before the injected `implement` callback (unit.test.ts's ordering
//     test fails an `implement` that runs before the oracle.captured/oracle.flagged event exists).
// (2) verifySeal and verifyPreSealedWall run before an oracle or Wall is trusted. runUnit re-checks
//     the Wall from disk/log right after sealing and again before `implement` or checkEquivalence,
//     so a just-sealed or crash-resumed Wall is never trusted from a return value alone.
// (3) parsePytestOutput turns real pytest stdout into a BaseRunOutcome and fails closed (no summary
//     line, no parsed integer) on garbled or truncated output.
// (4) A pytest collection error (exit 2) is classified by classifyBaseRun: no second classifier here.
// (5) MODERNIZE.md:153/262 no-op ablation: an injected stub runner replaces the new unit with stubs;
//     the oracle cases must then FAIL equivalence, else NOT_PROVEN "oracle does not constrain unit".
// (6) Conformance files (tests, conftest.py, pytest config) and every .py are hashed at Wall-seal
//     time and must be unchanged on the new tree before the post-implement run is trusted.
// (7) FC-24 (docs/v10/FAILURE-CLASSES.md): target conformance is runner_reported. Checks (6) and the
//     per-test identity check stop accidental and low-effort false passes, not unit code that
//     deliberately subverts pytest in-process. PROVEN's conformance leg carries that limit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import type { EquivNormalizers, SealedOracle } from "./oracle/seal.ts";
import { alreadySealedInLog, sealOracle, verifySeal } from "./oracle/seal.ts";
import type { BaseConformanceRunner, BaseRunOutcome, PreSealedWallResult } from "./presealed_wall.ts";
import { classifyBaseRun, sealPreSealedWall, verifyPreSealedWall } from "./presealed_wall.ts";
import type { EquivResult, NewCaseRunner } from "./equiv.ts";
import { checkEquivalence } from "./equiv.ts";
import { tokenFreeEnv } from "../../util/safe_git.ts";
import { nodeidKey } from "../../util/python.ts";
import type { CollectRunner } from "../../util/python.ts";
import { oracleDir } from "./types.ts";
import type { ModernizeTarget } from "./types.ts";

// (6): conformance-file binding.
const CONF_EVENT = "unit.conformance_sealed";
const SKIP_DIRS = new Set([".git", ".loki", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".tox"]);
const skipName = (n: string): boolean => SKIP_DIRS.has(n.toLowerCase());
// Case-insensitive: pytest on a case-insensitive filesystem (macOS APFS) loads pkg/Conftest.py as a conftest.
const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/i;
// Anything that can change what `python -m pytest` runs or reports; a NEW one is refused, not just a changed one.
const PYTEST_CFG = /(^|\/)(conftest\.py|\.?pytest\.(ini|toml)|pytest\.py|pyproject\.toml|setup\.cfg|tox\.ini|sitecustomize\.py|usercustomize\.py)$|\.pth$|(^|\/)pytest\//i;

/** True for a path whose NAME can steer what pytest loads or reports (case-insensitively). */
export function isSealedName(rel: string): boolean { return TEST_FILE.test(rel) || PYTEST_CFG.test(rel); }

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
      else if (!skipName(e.name)) walk(full);
    }
  };
  walk(dir);
}

const LINK = "symlink:";
// Only VCS and run state are fully skipped. Everything else, SKIP_DIRS included, is recorded (a
// norecursedirs override or a link makes pytest walk node_modules/venv/.tox). __pycache__ and
// .pytest_cache hold only purged/disabled caches and are skipped.
const FULL_SKIP = new Set([".git", ".loki"]);
const CACHE_DIRS = new Set(["__pycache__", ".pytest_cache"]);

/** Digest of a link target resolving outside `dir` (inside, it is hashed under its own path): file
 *  bytes, or directory names plus file bytes (nested links by target string); capped, fail closed. */
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

/** sha256 of EVERY regular file under dir (fixtures and golden data are bound), keyed by relative
 *  path. Under SKIP_DIRS only sealed names are hashed; other entries are "entry:file" / "entry:dir".
 *  A symlink is never followed: "symlink:<target>|<digest>" (digest of the bytes when outside dir). */
export function conformanceHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rels: string[] = [];
  const walk = (sub: string, inSkip: boolean): void => {
    let ents;
    try { ents = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (FULL_SKIP.has(e.name.toLowerCase())) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      const cache = CACHE_DIRS.has(e.name.toLowerCase());
      if (e.isSymbolicLink()) { rels.push(rel); continue; } // a link is recorded, never descended
      if (cache) continue;
      const skipped = inSkip || skipName(e.name);
      if (e.isDirectory()) {
        if (skipped) out[rel] = "entry:dir";
        walk(rel, skipped);
      } else if (!skipped || isSealedName(rel)) {
        rels.push(rel);
      } else {
        out[rel] = "entry:file";
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
  const r = spawnSync(target, ["-I", "-c", code, ...names], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000, env: tokenFreeEnv() });
  // fail closed: if the probe cannot run, every name counts as shadowing
  return r.status === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : new Set(names);
}

/** First way `now` departs from the sealed `base` set, or null: a sealed test/config file changed or
 *  removed; a test or config-class file the base never had; or a .py outside the card's `files`
 *  changed, removed or added. Without `files`, only the importable-outside-repo fallback applies to
 *  added modules (a changed module cannot be told apart from the unit's own code). */
function conformanceDrift(base: Record<string, string>, now: Record<string, string>, files: string[] | undefined, target: string): string | null {
  const sealed = (p: string): boolean => TEST_FILE.test(p) || PYTEST_CFG.test(p);
  const listed = (p: string): boolean => !!files?.some((f) => p === f || p.startsWith(f.replace(/\/?$/, "/")));
  const link = (h: string | undefined): boolean => !!h?.startsWith(LINK);
  // Sealed test/config files and any symlink (pytest follows linked dirs) are immutable. Otherwise a
  // listed path may change; an unlisted one may not when a file list exists, else non-.py data is immutable.
  const immutable = (p: string, linked: boolean): boolean =>
    sealed(p) || linked || (!listed(p) && (!!files || !p.toLowerCase().endsWith(".py")));
  // Sorted so the named path is the same on every platform (readdir order differs).
  for (const [p, h] of Object.entries(base).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (now[p] === h) continue;
    if (immutable(p, link(h) || link(now[p]))) return `${p} ${p in now ? "changed" : "removed"}`;
  }
  const added = Object.keys(now).filter((p) => !(p in base)).sort();
  for (const p of added) if (immutable(p, link(now[p]))) return `${p} added`;
  if (files) return null;
  const tops = [...new Set(added.map((p) => p.split("/")[0]!.replace(/\.py$/, "")))];
  const bad = importableOutsideRepo(target, tops);
  const hit = added.find((p) => bad.has(p.split("/")[0]!.replace(/\.py$/, "")));
  return hit ? `${hit} added (shadows a module importable outside the repo)` : null;
}

/** Why the post-implement run is not a full pass of the sealed tests, or null. Fails closed. Every
 *  `expected` identity ("classname::name") must be passed (not skipped, xfailed, xpassed or error). */
export function conformanceShortfall(expected: string[] | undefined, now: Pick<BaseRunOutcome, "counts" | "tests"> | undefined): string | null {
  if (!expected || expected.length === 0) return "no sealed test identities were recorded";
  if (!now?.counts || !now.tests) return "no verified pytest footer (the run did not finish or its report disagrees)";
  if (now.counts.failed > 0 || now.counts.errors > 0) return `${now.counts.failed} failed, ${now.counts.errors} errors`;
  const bad = expected.filter((id) => now.tests![id] !== "passed");
  if (bad.length === 0) return null;
  return `${bad.length} of ${expected.length} sealed tests did not pass (${bad.slice(0, 3).map((id) => `${id}: ${now.tests![id] ?? "did not run"}`).join(", ")})`;
}

// (1)/(2): card to v10 run orchestration.

/** One unit's card (section 3.3), narrowed to what runUnit needs. `newTreeDir` defaults to `repoDir`
 *  (in place); per-unit worktree isolation is the scheduler's job (M-17). */
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

/** Modernizes one unit in place; must leave `newTreeDir` modernized before returning. runUnit calls
 *  it only after the oracle and pre-sealed Wall are sealed and verified (1)/(2). */
export type Implementer = (card: UnitCard) => void;

export interface UnitRunResult {
  unit: string;
  verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
  oracle: SealedOracle | null;
  wall: PreSealedWallResult | null;
  equiv: EquivResult | null;
  not_proven: string[];
  /** Set only on PROVEN: the conformance leg is runner_reported under the FC-24 limit. null on every other verdict. */
  conformance: { trust: "runner_reported"; limit: "FC-24"; tests: number } | null;
}

function notProvenUnitResult(
  unit: string,
  reason: string,
  oracle: SealedOracle | null,
  wall: PreSealedWallResult | null,
): UnitRunResult {
  return { unit, verdict: "NOT_PROVEN", oracle, wall, equiv: null, not_proven: [reason], conformance: null };
}

function readOracleSealed(repoDir: string, mid: string, unit: string): SealedOracle {
  return JSON.parse(readFileSync(join(oracleDir(repoDir, mid, unit), "sealed.json"), "utf8")) as SealedOracle;
}

/** Card to v10 run: seals the oracle, seals and verifies the pre-sealed Wall against the base
 *  tree, only THEN runs the implementation, and finally checks equivalence (section 3.4/3.5, D30).
 *  Every failing step becomes a NOT_PROVEN result, never a throw. Ordering (1): sealOracle is the
 *  first call, strictly before `implement(card)`. Trust (2): verifySeal and verifyPreSealedWall
 *  gate the oracle and Wall, both re-read from disk/log, not from a return value. */
export function runUnit(
  card: UnitCard,
  log: ModernizeLog,
  runConformance: BaseConformanceRunner,
  implement: Implementer,
  runNew: NewCaseRunner,
  /** Runs an oracle case against the unit REPLACED BY STUBS (the no-op ablation). Required for PROVEN. */
  runStub?: NewCaseRunner,
  /** Collects the sealed test files' nodeids after implement; required when the base was a collection error. */
  collect?: CollectRunner,
): UnitRunResult {
  const { repoDir, mid, unit } = card;
  const newTreeDir = card.newTreeDir ?? repoDir;

  // (1) sealOracle first, unconditionally, before implement is ever reachable below.
  if (!alreadySealedInLog(repoDir, mid, unit)) {
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

  // Pre-sealed Wall: conformance on the base tree, before `implement`; a green or not_run base refuses the seal (D42 (3)).
  let freshSeal = false;
  let expected: string[] | null | undefined; // sealed test identities; null = base never collected, derive post-implement
  try {
    const attempt = sealPreSealedWall(repoDir, mid, unit, card.target, (u, d) => {
      const o = runConformance(u, d);
      expected = o.exitCode === 2 ? null : o.tests && Object.entries(o.tests).filter(([, v]) => v === "passed" || v === "failed" || v === "error").map(([k]) => k);
      return o;
    }, log, card.baseSha ?? null);
    if (!attempt.sealed) {
      return notProvenUnitResult(unit, attempt.reason ?? "presealed wall not sealed", oracle, attempt);
    }
    freshSeal = true;
  } catch (e) {
    // Write-once throw: already sealed by a prior run; verifyPreSealedWall below is the trust check.
    void e;
  }

  // (2) verifyPreSealedWall before trusting the Wall, just sealed or resumed.
  const wallCheck = verifyPreSealedWall(repoDir, mid, unit);
  if (!wallCheck.ok) {
    return notProvenUnitResult(unit, `presealed wall invalid: ${wallCheck.reason ?? "unknown"}`, oracle, null);
  }
  // Read the classification back from the "wall.presealed.sealed" event rather than assuming it:
  // sealPreSealedWall only seals on "red" today, but the B2 check must not rely on that silently.
  const sealedEvent = readModernizeEvents(repoDir, mid).find(
    (e) => e.type === "wall.presealed.sealed" && e.data.unit === unit,
  );
  const wall: PreSealedWallResult = {
    unit,
    classification: sealedEvent?.data.classification === "red" ? "red" : "not_run",
    sealed: true,
  };

  // (6) Bind conformance files to the seal: hashed from the pristine base tree and persisted, so a
  // resumed run never re-hashes a modified tree. No record, no PROVEN.
  const bound = readModernizeEvents(repoDir, mid).find((e) => e.type === CONF_EVENT && e.data.unit === unit);
  let sealedHashes = bound?.data.files as Record<string, string> | undefined;
  if (!sealedHashes) {
    if (!freshSeal) return notProvenUnitResult(unit, "conformance files not bound to the seal (no record from seal time)", oracle, wall);
    sealedHashes = conformanceHashes(repoDir);
    log.append(CONF_EVENT, { unit, files: sealedHashes, expected: expected === undefined ? [] : expected });
  } else {
    expected = bound?.data.expected as string[] | null | undefined;
  }

  // Only now: the actual code change.
  implement(card);
  purgePycache(newTreeDir);

  const equiv = checkEquivalence(repoDir, mid, unit, newTreeDir, card.normalizers, runNew, log);
  if (equiv.verdict !== "PROVEN") {
    return { unit, verdict: equiv.verdict, oracle, wall, equiv, not_proven: equiv.not_proven, conformance: null };
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
  // Target conformance re-run against the MODERNIZED tree must pass: matching the oracle alone is not modernized.
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
  // A bare exit 0 is not proof (os._exit(0), pytest.exit, all-skipped): every sealed test identity must be passed in the junit report (FC-24).
  let want = expected ?? undefined;
  if (expected === null) {
    const files = Object.keys(sealedHashes).filter((p) => TEST_FILE.test(p) && !p.split("/").some(skipName) && !sealedHashes![p]!.startsWith(LINK) && !sealedHashes![p]!.startsWith("entry:"));
    if (!collect || files.length === 0) return notProvenUnitResult(unit, "target conformance run is not a full pass: base never collected and no sealed tests can be collected", oracle, wall);
    const col = collect(unit, newTreeDir, files);
    if (!col.ok) return notProvenUnitResult(unit, `target conformance run is not a full pass: ${col.reason}`, oracle, wall);
    want = col.nodeids.map(nodeidKey);
  }
  const shortfall = conformanceShortfall(want, newOutcome);
  if (shortfall) return notProvenUnitResult(unit, `target conformance run is not a full pass: ${shortfall}`, oracle, wall);

  const tests = want!.length; // non-empty: conformanceShortfall refuses an empty or missing set
  log.append("unit.conformance_passed", { unit, trust: "runner_reported", limit: "FC-24", tests });
  return { unit, verdict: "PROVEN", oracle, wall, equiv, not_proven: [], conformance: { trust: "runner_reported", limit: "FC-24", tests } };
}
