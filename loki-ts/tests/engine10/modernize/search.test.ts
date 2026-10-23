import { setSpawnTimeout } from "../../preload.ts";
setSpawnTimeout();
// M-10: coverage-guided input search (docs/v10/MODERNIZE.md section 3.2). The provider (propose)
// and the capture executor (runCapture) are both stubbed, per section 13 "Tests deterministic
// with a stub provider" -- no python or py_capture.py dependency here.
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ModernizeLog } from "../../../src/engine10/modernize/log.ts";
import { sealOracle } from "../../../src/engine10/modernize/oracle/seal.ts";
import { captureUnitOracle, makeProposeInputs, realCaptureRunner, search } from "../../../src/engine10/modernize/oracle/search.ts";
import type { ProposeSession } from "../../../src/engine10/modernize/oracle/search.ts";
import { oracleDir } from "../../../src/engine10/modernize/types.ts";
import type { CaptureRunner, CaseSpec, CoverageMissing, ProposeInputs } from "../../../src/engine10/modernize/oracle/search.ts";

const UNIT_SRC = "def f(x):\n    if x:\n        return 1\n    return 0\n";

// Four synthetic branches. A case "covers" a branch when its `entry` equals that branch's key
// ("<line>:<outcome>"); anything else covers nothing. This is enough to exercise "keeps only the
// inputs that add branches" without a real tracer.
const B10T: CoverageMissing = { line: 10, outcome: "true" };
const B10F: CoverageMissing = { line: 10, outcome: "false" };
const B20T: CoverageMissing = { line: 20, outcome: "true" };
const B20F: CoverageMissing = { line: 20, outcome: "false" };
const ALL = [B10T, B10F, B20T, B20F];
const key = (b: CoverageMissing) => `${b.line}:${b.outcome}`;

function stubCapture(): CaptureRunner {
  return (_src, cases) => {
    const covered = new Set(cases.map((c) => c.entry).filter((e) => ALL.some((b) => key(b) === e)));
    const missing = ALL.filter((b) => !covered.has(key(b)));
    return {
      branchesTotal: ALL.length,
      branchesTaken: covered.size,
      branchPct: (100 * covered.size) / ALL.length,
      missing,
    };
  };
}

const caseFor = (b: CoverageMissing): CaseSpec => ({ entry: key(b), args: [], kwargs: {} });

describe("search", () => {
  it("stops full_coverage without calling propose when seed cases already cover everything", () => {
    const seed = ALL.map(caseFor);
    let proposeCalls = 0;
    const propose: ProposeInputs = () => {
      proposeCalls++;
      return [];
    };
    const result = search(UNIT_SRC, seed, propose, stubCapture());
    expect(result.stoppedReason).toBe("full_coverage");
    expect(result.rounds).toHaveLength(0);
    expect(proposeCalls).toBe(0);
    expect(result.coverage.branchesTaken).toBe(4);
  });

  it("keeps only candidates that add a branch, drops duplicates, reaches full_coverage", () => {
    const rounds: CaseSpec[][] = [
      [caseFor(B10T), caseFor(B10T), caseFor(B20T)], // duplicate B10T is proposed twice
      [], // no-gain round; does not itself trigger a plateau (streak resets after)
      [caseFor(B10F)],
      [caseFor(B20F)],
    ];
    let i = 0;
    const propose: ProposeInputs = () => rounds[i++] ?? [];

    const result = search(UNIT_SRC, [], propose, stubCapture());

    expect(result.stoppedReason).toBe("full_coverage");
    expect(result.rounds).toHaveLength(4);
    expect(result.rounds[0]).toEqual({ round: 1, proposed: 3, kept: 2, branchesTaken: 2, branchPct: 50 });
    expect(result.rounds[1]).toEqual({ round: 2, proposed: 0, kept: 0, branchesTaken: 2, branchPct: 50 });
    expect(result.rounds[2]).toMatchObject({ round: 3, proposed: 1, kept: 1, branchesTaken: 3 });
    expect(result.rounds[3]).toMatchObject({ round: 4, proposed: 1, kept: 1, branchesTaken: 4 });
    // seed (none) + 2 kept round 1 + 1 kept round 3 + 1 kept round 4 = 4, duplicate never kept
    expect(result.cases).toHaveLength(4);
    expect(result.coverage.missing).toHaveLength(0);
  });

  it("stops at a plateau after two consecutive no-gain rounds (default plateauRounds)", () => {
    let calls = 0;
    const propose: ProposeInputs = () => {
      calls++;
      return [caseFor(B10T)]; // already kept after round 1, so rounds 2-3 add nothing new
    };
    const result = search(UNIT_SRC, [], propose, stubCapture());

    expect(result.stoppedReason).toBe("plateau");
    expect(calls).toBe(3); // round 1 (kept), round 2 and 3 (no gain -> plateau)
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds[0]!.kept).toBe(1);
    expect(result.rounds[1]!.kept).toBe(0);
    expect(result.rounds[2]!.kept).toBe(0);
    expect(result.coverage.branchesTaken).toBe(1);
  });

  it("an empty-propose round counts toward the plateau", () => {
    const propose: ProposeInputs = () => [];
    const result = search(UNIT_SRC, [], propose, stubCapture());
    expect(result.stoppedReason).toBe("plateau");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds.every((r) => r.proposed === 0 && r.kept === 0)).toBe(true);
  });

  it("stops at the capture budget (maxRounds) when never reaching a plateau or full coverage", () => {
    const order = [B10T, B10F, B20T, B20F];
    const propose: ProposeInputs = (_src, _missing, round) => {
      const b = order[round - 1];
      return b ? [caseFor(b)] : [];
    };
    const result = search(UNIT_SRC, [], propose, stubCapture(), { maxRounds: 2 });

    expect(result.stoppedReason).toBe("budget");
    expect(result.rounds).toHaveLength(2);
    expect(result.coverage.branchesTaken).toBe(2);
    expect(result.coverage.missing).toHaveLength(2);
  });

  it("honors a custom plateauRounds", () => {
    const propose: ProposeInputs = () => [];
    const result = search(UNIT_SRC, [], propose, stubCapture(), { plateauRounds: 1 });
    expect(result.stoppedReason).toBe("plateau");
    expect(result.rounds).toHaveLength(1);
  });

  it("gives propose the unit source and exactly the current round's uncovered branches", () => {
    const seen: { unitSource: string; missing: readonly CoverageMissing[]; round: number }[] = [];
    const propose: ProposeInputs = (unitSource, missing, round) => {
      seen.push({ unitSource, missing, round });
      if (round === 1) return [caseFor(B10T)]; // covers B10T only
      return []; // plateau from round 2
    };
    search(UNIT_SRC, [], propose, stubCapture());

    expect(seen).toHaveLength(3); // round 1 (kept) + rounds 2-3 (no gain -> plateau)
    expect(seen[0]).toEqual({ unitSource: UNIT_SRC, missing: ALL, round: 1 });
    // round 2 must see the POST-round-1 missing list (B10T now covered), not the stale round-1 one
    expect(seen[1]!.missing).toEqual([B10F, B20T, B20F]);
    expect(seen[2]!.missing).toEqual([B10F, B20T, B20F]);
  });

  // Reviewer-reproduced blocking finding: a failed seed capture (py_capture.py's CAPTURE_FAILED
  // shape -- branchesTotal/branchesTaken -1) must end the search as failed, never be reported as
  // a plateau at a fabricated 0% that section 3.2's 80% coverage floor would then act on.
  it("ends as capture_failed when the seed capture fails, never calls propose, never plateaus", () => {
    let proposeCalls = 0;
    const propose: ProposeInputs = () => {
      proposeCalls++;
      return [];
    };
    // A distinct, arbitrary cause -- never "old runtime unavailable" -- so this fails against any
    // fix that just hardcodes that one message instead of passing the runner's actual cause through.
    const failingCapture: CaptureRunner = () => ({
      branchesTotal: -1, branchesTaken: -1, branchPct: 0,
      missing: [{ line: -1, outcome: "true" }], error: "py_capture.py exit 2: SyntaxError",
    });
    const result = search(UNIT_SRC, [], propose, failingCapture);

    expect(result.stoppedReason).toBe("capture_failed");
    expect(result.reason).toBe("py_capture.py exit 2: SyntaxError");
    expect(proposeCalls).toBe(0);
    expect(result.rounds).toHaveLength(0);
  });
});

const PYTHON3 = ["/opt/homebrew/bin/python3.12", "python3.12", "python3"].find(
  (cmd) => !spawnSync(cmd, ["--version"]).error,
);
// realCaptureRunner resolves the OLD runtime (section 3.2), never the new one: LOKI_MOD_OLD_RUNTIME,
// else python2.7/python2 on PATH -- exactly tests/test-modernize-py-capture.sh section 12's gate.
const OLD_RUNTIME =
  process.env["LOKI_MOD_OLD_RUNTIME"] ||
  ["python2.7", "python2"].find((cmd) => !spawnSync(cmd, ["--version"]).error);
const FIXTURE_UNIT = join(import.meta.dir, "fixtures", "search", "branch.py");

// Shared by both describes below: realCaptureRunner reaches full coverage on branch.py and drops
// an untrusted bad-entry candidate without aborting the search.
function expectFullCoverageOnBranchPy(): void {
  const trueCase: CaseSpec = { entry: "f", args: [{ t: "bool", v: true }], kwargs: {} };
  const falseCase: CaseSpec = { entry: "f", args: [{ t: "bool", v: false }], kwargs: {} };
  const badEntryCase: CaseSpec = { entry: "does_not_exist", args: [], kwargs: {} };
  let round1 = true;
  const propose: ProposeInputs = () => {
    if (round1) {
      round1 = false;
      return [badEntryCase, falseCase]; // bad candidate first: must not abort the good one
    }
    return [];
  };
  const result = search(FIXTURE_UNIT, [trueCase], propose, realCaptureRunner);

  expect(result.stoppedReason).toBe("full_coverage");
  expect(result.coverage.missing).toHaveLength(0);
  expect(result.coverage.branchesTaken).toBe(2);
  // seed + falseCase kept; badEntryCase dropped (its trial capture exits 2, never crashes)
  expect(result.cases).toEqual([trueCase, falseCase]);
}

// M-09 integration: realCaptureRunner actually shells out to py_capture.py under a REAL old
// runtime. Skipped (never faked green) when no old runtime is available, per
// test-modernize-py-capture.sh's own pattern -- this machine has no python2/python2.7.
describe.skipIf(!OLD_RUNTIME)("search with realCaptureRunner (py_capture.py, M-09)", () => {
  it("reaches full coverage on branch.py and drops an untrusted bad-entry candidate", expectFullCoverageOnBranchPy);
});

// Same path, exercised via an explicit LOKI_MOD_OLD_RUNTIME override instead of a real old
// runtime -- so the py_capture.py shell-out and untrusted-candidate handling are actually run on
// CI/dev machines with no python2/python2.7 (branch.py is 2/3-compatible and the assertions are
// structural, so this is honest harness-mechanics coverage, not faked 2.7 semantics).
describe.skipIf(!PYTHON3)("search with realCaptureRunner via LOKI_MOD_OLD_RUNTIME override (mechanics)", () => {
  it("reaches full coverage on branch.py and drops an untrusted bad-entry candidate", () => {
    const prev = process.env["LOKI_MOD_OLD_RUNTIME"];
    process.env["LOKI_MOD_OLD_RUNTIME"] = PYTHON3;
    try {
      expectFullCoverageOnBranchPy();
    } finally {
      if (prev === undefined) delete process.env["LOKI_MOD_OLD_RUNTIME"];
      else process.env["LOKI_MOD_OLD_RUNTIME"] = prev;
    }
  });
});

// Reviewer-reproduced blocking finding: realCaptureRunner hardcoded the NEW-runtime priority
// (util/python.ts's homebrew python3.12/python3.12/python3), never consulting LOKI_MOD_OLD_RUNTIME
// as section 3.2 requires -- so a 2/3-compatible unit silently got captured under the new
// runtime instead of the old one. Proven with a bogus override: the OLD code ignores it and
// still succeeds via homebrew python3.12 (present on this machine); the FIXED code must try only
// the override, get a spawn failure, and never fall back to a python3 discovery of any kind.
describe("realCaptureRunner honors LOKI_MOD_OLD_RUNTIME (section 3.2)", () => {
  it("uses only the override, never a new-runtime fallback, when the override does not exist", () => {
    const prev = process.env["LOKI_MOD_OLD_RUNTIME"];
    process.env["LOKI_MOD_OLD_RUNTIME"] = "/no/such/interpreter-loki-m10-test";
    try {
      const result = realCaptureRunner(FIXTURE_UNIT, [{ entry: "f", args: [{ t: "bool", v: true }], kwargs: {} }]);
      expect(result.branchesTotal).toBe(-1); // CAPTURE_FAILED: the override was consulted and honored
      expect(result.error).toBe("old runtime unavailable"); // the specific cause, not a new-runtime one
    } finally {
      if (prev === undefined) delete process.env["LOKI_MOD_OLD_RUNTIME"];
      else process.env["LOKI_MOD_OLD_RUNTIME"] = prev;
    }
  });
});

// M-27A: production oracle capture. Real py_capture.py under LOKI_MOD_OLD_RUNTIME=python3 on 2/3-compatible fixtures.
describe.skipIf(!PYTHON3)("captureUnitOracle (M-27A)", () => {
  const mid = "mod-20260928T010203Z-ab12cd";
  const T = { t: "bool", v: true }, F = { t: "bool", v: false };
  const both = [JSON.stringify({ entry: "f", args: [T], kwargs: {} }), JSON.stringify({ entry: "f", args: [F], kwargs: {} })].join("\n");
  let repoDir = "";
  let prev: string | undefined;
  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "e10-m27a-"));
    prev = process.env["LOKI_MOD_OLD_RUNTIME"];
    process.env["LOKI_MOD_OLD_RUNTIME"] = PYTHON3;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env["LOKI_MOD_OLD_RUNTIME"];
    else process.env["LOKI_MOD_OLD_RUNTIME"] = prev;
    rmSync(repoDir, { recursive: true, force: true });
  });
  const stub = (lines: string): ProposeSession => ({ cwd }) => writeFileSync(join(cwd, "proposals.jsonl"), lines);
  const unitFile = (src: string) => {
    const p = join(repoDir, "u.py");
    writeFileSync(p, src);
    return p;
  };

  it("captures branch.py, writes both files, and sealOracle accepts them", () => {
    const r = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)) });
    expect(r.ok).toBe(true);
    const dir = oracleDir(repoDir, mid, "branch");
    expect(existsSync(join(dir, "cases.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "coverage.json"))).toBe(true);
    expect(sealOracle(repoDir, mid, "branch", new ModernizeLog(repoDir, mid)).verdict).toBe("PROVEN_ORACLE");
  });

  it("marks a random-valued record not_proven with nondeterministic field return", () => {
    const unitPath = unitFile("import random\ndef f(x):\n    if x:\n        return random.random()\n    return 0\n");
    const r = captureUnitOracle({ repoDir, mid, unit: "rnd", unitPath, propose: makeProposeInputs(stub(both)) });
    expect(r.ok).toBe(true);
    const recs = readFileSync(join(oracleDir(repoDir, mid, "rnd"), "cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs.some((x) => x.not_proven.includes("nondeterministic field return"))).toBe(true);
    expect(recs.some((x) => x.not_proven.length === 0)).toBe(true);
  });

  it("fails closed with no files when the old runtime is unavailable", () => {
    process.env["LOKI_MOD_OLD_RUNTIME"] = "/no/such/interpreter-loki-m27a";
    const r = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)) });
    expect(r).toEqual({ ok: false, reason: "old runtime unavailable" });
    expect(existsSync(join(oracleDir(repoDir, mid, "branch"), "cases.jsonl"))).toBe(false);
    expect(existsSync(join(oracleDir(repoDir, mid, "branch"), "coverage.json"))).toBe(false);
  });

  it("refuses a second capture; a throwing propose captures nothing and writes nothing", () => {
    const throwing = () => { throw new Error("session died"); };
    const none = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: throwing });
    expect(none).toEqual({ ok: false, reason: "no cases captured" });
    expect(existsSync(oracleDir(repoDir, mid, "branch"))).toBe(false);
    const first = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)) });
    expect(first.ok).toBe(true);
    const again = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)) });
    expect(again.ok).toBe(false);
  });

  it("never overwrites a cases.jsonl that appears during replay", () => {
    const dir = oracleDir(repoDir, mid, "branch");
    const racing: CaptureRunner = (u, c, out) => {
      if (out) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "cases.jsonl"), "SENTINEL"); }
      return realCaptureRunner(u, c, out);
    };
    const r = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)), runCapture: racing });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, "cases.jsonl"), "utf8")).toBe("SENTINEL");
  });

  it("a cases.jsonl appearing between the existence check and linkSync gives ok:false and is never overwritten (M-27A-b)", () => {
    const dir = oracleDir(repoDir, mid, "branch");
    const link = ((src: string, dst: string) => { writeFileSync(dst, "SENTINEL"); return linkSync(src, dst); }) as typeof linkSync;
    const r = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)), link });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, "cases.jsonl"), "utf8")).toBe("SENTINEL");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("a failed link removes the empty parent dirs it created, but never a pre-existing one (M-27A-b)", () => {
    const boom = (() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as unknown as typeof linkSync;
    const r = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)), link: boom });
    expect(r.ok).toBe(false);
    expect(existsSync(join(repoDir, ".loki"))).toBe(false);
    const keep = join(repoDir, ".loki");
    mkdirSync(keep, { recursive: true });
    captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)), link: boom });
    expect(existsSync(keep)).toBe(true);
    expect(readdirSync(keep)).toEqual([]);
  });

  it("a failed replay leaves no oracle dir", () => {
    const failing: CaptureRunner = (u, c, out) => (out ? { branchesTotal: -1, branchesTaken: -1, branchPct: 0, missing: [], error: "replay boom" } : realCaptureRunner(u, c));
    const r = captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: makeProposeInputs(stub(both)), runCapture: failing });
    expect(r).toEqual({ ok: false, reason: "replay boom" });
    expect(existsSync(oracleDir(repoDir, mid, "branch"))).toBe(false);
  });

  it("the extra round under 80% sees a later round number", () => {
    const rounds: number[] = [];
    captureUnitOracle({ repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT, propose: (_u, _m, rd) => { rounds.push(rd); return []; } });
    expect(rounds).toEqual([1, 2, 3]);
  });

  it("runs the propose session outside repoDir with a token-free env", () => {
    process.env["GITHUB_TOKEN"] = "ghp_secret";
    let seen: { cwd: string; token: string | undefined } | undefined;
    try {
      captureUnitOracle({
        repoDir, mid, unit: "branch", unitPath: FIXTURE_UNIT,
        propose: makeProposeInputs(({ cwd, env }) => { seen = { cwd, token: env["GITHUB_TOKEN"] }; }),
      });
    } finally {
      delete process.env["GITHUB_TOKEN"];
    }
    expect(seen).toBeDefined();
    expect(seen!.cwd.startsWith(repoDir)).toBe(false);
    expect(seen!.token === undefined || seen!.token !== "ghp_secret").toBe(true);
  });
});

describe("realCaptureRunner isolation (M-27F)", () => {
  it("spawns the old runtime token-free in a temp cwd that is removed afterwards", () => {
    const d = mkdtempSync(join(tmpdir(), "m27f-"));
    const fake = join(d, "fakepy"), dump = join(d, "dump.txt");
    writeFileSync(fake, `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nprintf '%s|%s' "$GITHUB_TOKEN" "$PWD" > "${dump}"\nexit 1\n`, { mode: 0o755 });
    const prev = { rt: process.env["LOKI_MOD_OLD_RUNTIME"], tok: process.env["GITHUB_TOKEN"] };
    process.env["LOKI_MOD_OLD_RUNTIME"] = fake;
    process.env["GITHUB_TOKEN"] = "ghp_secret";
    try {
      const r = realCaptureRunner(FIXTURE_UNIT, []);
      expect(r.error).toContain("py_capture.py exit 1");
      const [tok, cwd] = readFileSync(dump, "utf8").split("|");
      expect(tok).not.toBe("ghp_secret");
      expect(cwd!.startsWith(process.cwd())).toBe(false);
      expect(existsSync(cwd!)).toBe(false);
    } finally {
      if (prev.rt === undefined) delete process.env["LOKI_MOD_OLD_RUNTIME"]; else process.env["LOKI_MOD_OLD_RUNTIME"] = prev.rt;
      if (prev.tok === undefined) delete process.env["GITHUB_TOKEN"]; else process.env["GITHUB_TOKEN"] = prev.tok;
      rmSync(d, { recursive: true, force: true });
    }
  });
});
