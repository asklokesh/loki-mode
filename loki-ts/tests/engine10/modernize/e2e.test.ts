// select: not-src-walker (its "src" is a tmp git fixture repo, not loki-ts/src)
// M-26: end-to-end `loki modernize` on a tracked py2 fixture repo with a deterministic stub provider
// (docs/v10/MODERNIZE.md section 7). No network, no model. Two entry points are driven for real:
//   - main(): the full-repo coordinator. Its production wave deps still name unbuilt pieces and exit 2;
//     the test asserts that exact honest exit and never a fabricated success.
//   - unitMain(): the per-unit entry (`loki modernize unit`). Real checkout, real seal, real pytest on
//     the base and the modernized tree, real py_capture replay; only the model session is a stub.
// The golden oracle (fixtures/e2e_py2/oracle_golden) was captured by py_capture.py from the behavior-equal
// py3 form of legacy/calc.py:tally; production oracle capture is one of the pieces main() names as missing.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../src/engine10/modernize/cli.ts";
import { readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { oracleDir } from "../../../src/engine10/modernize/types.ts";
import { runUnit } from "../../../src/engine10/modernize/unit.ts";
import type { UnitRunResult } from "../../../src/engine10/modernize/unit.ts";
import type { NewCaseOutcome } from "../../../src/engine10/modernize/equiv.ts";
import { fetchRepoRef, makeUnitRunners, unitMain } from "../../../src/util/modernize_unit.ts";
import { makePytestBaseRunner } from "../../../src/util/python.ts";
import { safeGit } from "../../../src/util/safe_git.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "e2e_py2");
const MID = "mod-20261016T000000Z-e2e001";
const UNIT = "calc"; // unit ids are one safe path segment (no "/")
const UNIT_FILE = "legacy/calc.py";

const pyProbe = spawnSync("python3", ["-m", "pytest", "--version"], { encoding: "utf8" });
const SKIP_REASON = pyProbe.status === 0 ? "" : "python3 with pytest is not available on this host";
if (SKIP_REASON) process.stderr.write(`SKIP e2e modernize: ${SKIP_REASON}\n`);

function captureStd() {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "", err = "";
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
  return { restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; }, get out() { return out; }, get err() { return err; } };
}

/** The deterministic stub provider: a fixed py2 to py3 rewrite of the unit's source, no model. */
export function py2to3(src: string): string {
  return src
    .replace(/^(\s*)print (.+)$/gm, "$1print($2)")
    .replace(/^(\s*)print$/gm, "$1print()")
    .replace(/\.iteritems\(\)/g, ".items()")
    .replace(/\bunicode\b/g, "str");
}

const PY2_FILES = ["legacy/calc.py", "legacy/report.py"]; // the non-test py2 sources the stub converts
interface Stub { calls: { brief: string; cwd: string }[]; converted: Record<string, string>; session: (brief: string, cwd: string, env: NodeJS.ProcessEnv) => { status: number | null } }
function stubProvider(transform: (src: string) => string): Stub {
  const calls: Stub["calls"] = [];
  const converted: Record<string, string> = {};
  return {
    calls,
    converted,
    session: (brief, cwd, env) => {
      calls.push({ brief, cwd });
      expect(env["GITHUB_TOKEN"] ?? "").toMatch(/^$|WITHHELD/); // the implement agent never holds a real credential
      for (const rel of PY2_FILES) {
        const file = join(cwd, rel);
        const out = transform(readFileSync(file, "utf8"));
        writeFileSync(file, out);
        converted[rel] = out;
      }
      return { status: 0 };
    },
  };
}

let root = "";
let repo = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "e10-m26-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  // Tracked py2 fixture repo; the golden oracle stays outside it (it is injected at checkout, as production capture would write it).
  cpSync(FIXTURE, repo, { recursive: true, filter: (s) => !s.includes("oracle_golden") });
  safeGit(repo, ["init", "-q", "-b", "main"]);
  safeGit(repo, ["add", "legacy", "tests"]);
  safeGit(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "py2 fixture"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Real unit-level pipeline on the fixture, with the golden oracle placed where oracle capture would put it. */
async function driveUnit(stub: Stub, opts: { pythonBin?: string; ablate?: boolean } = {}) {
  const runners = makeUnitRunners({ target: "python3", session: stub.session, unitFile: (_id, dir) => join(dir, UNIT_FILE),...(opts.pythonBin ? { pythonBin: opts.pythonBin } : {}) });
  const seen: { result: UnitRunResult | null; events: string[]; sealedExists: boolean; conformance: number[] } = { result: null, events: [], sealedExists: false, conformance: [] };
  const real = makePytestBaseRunner();
  const stubbed = (): NewCaseOutcome => ({ return: { t: "none" }, exc: null, stdout: { t: "text", v: "" }, files: [] });
  const cap = captureStd();
  let code: number;
  try {
    code = await unitMain(["--repo", "acme/py2fixture", "--ref", "main", "--unit", UNIT, "--mid", MID], {
      makeId: () => MID,
      unit: {
        tmpRoot: root,
        checkout: (r, ref, dest) => {
          fetchRepoRef(r, ref, dest, () => repo); // owner/name is validated; the URL maps to the local fixture repo
          const od = oracleDir(dest, MID, UNIT);
          mkdirSync(od, { recursive: true });
          cpSync(join(FIXTURE, "oracle_golden"), od, { recursive: true });
        },
        implement: runners.implement,
        runNew: runners.runNew,
        runStub: stubbed, // no-op ablation: the unit replaced by stubs must go red against the oracle
        runConformance: (u, d) => { const o = real(u, d); seen.conformance.push(o.exitCode ?? -1); return o; },
        runUnit: ((card, log, ...rest) => {
          const r = (runUnit as (...a: unknown[]) => UnitRunResult)(card, log, ...rest);
          seen.result = r;
          seen.events = readModernizeEvents(card.repoDir, card.mid).map((e) => e.type);
          seen.sealedExists = existsSync(join(oracleDir(card.repoDir, card.mid, card.unit), "sealed.json"));
          return r;
        }) as typeof runUnit,
      },
    });
  } finally { cap.restore(); }
  return { code, out: cap.out, err: cap.err, ...seen };
}

describe("py2 to py3 stub provider", () => {
  it("rewrites print statements, dict.iteritems and unicode, deterministically", () => {
    const src = readFileSync(join(FIXTURE, UNIT_FILE), "utf8") + readFileSync(join(FIXTURE, "legacy/report.py"), "utf8");
    const out = py2to3(src);
    expect(out).toContain('print("total", total)');
    expect(out).toContain("    print()");
    expect(out).toContain("scores.items()");
    expect(out).toContain("isinstance(raw, str)");
    expect(out).not.toMatch(/iteritems|unicode|print "/);
    expect(py2to3(src)).toBe(out);
  });
});

describe("loki modernize e2e on the py2 fixture", () => {
  it.skipIf(SKIP_REASON !== "")("dry-run inventories the py2 repo and spends nothing", async () => {
    const cap = captureStd();
    let code: number;
    try { code = await main([repo, "--to", "python3", "--dry-run"], { makeId: () => MID }); } finally { cap.restore(); }
    expect(code).toBe(0);
    expect(cap.out).toMatch(/units?:?\s*\d/i);
    const types = readModernizeEvents(repo, MID).map((e) => e.type);
    expect(types).toEqual(["modernize.started", "inventory.completed", "estimate.printed"]);
  });

  it.skipIf(SKIP_REASON !== "")("full-repo run exits 2 naming every unbuilt piece, converts nothing, claims no success", async () => {
    const before = readFileSync(join(repo, UNIT_FILE), "utf8");
    const cap = captureStd();
    let code: number;
    try { code = await main([repo, "--to", "python3", "--no-pr"], { makeId: () => MID }); } finally { cap.restore(); }
    expect(code).toBe(2);
    expect(cap.err).toContain("modernize: cannot run units yet, not built:");
    for (const piece of ["oracle capture", "unit merge ops", "ablation stub runner", "wave verify commands"]) expect(cap.err).toContain(piece);
    expect(cap.err).toContain("use --dry-run");
    expect(cap.out).not.toMatch(/verified|shipped|PROVEN/);
    expect(readFileSync(join(repo, UNIT_FILE), "utf8")).toBe(before);
  });

  it.skipIf(SKIP_REASON !== "")("unit run: stub provider converts the unit, pytest passes under py3, oracle sealed, PROVEN", async () => {
    const stub = stubProvider(py2to3);
    const base = spawnSync("python3", ["-m", "pytest", "-q", "-p", "no:cacheprovider"], { cwd: repo, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(base.status).not.toBe(0); // the py2 base cannot run under python3: the Wall seals on a red base
    const r = await driveUnit(stub);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`unit ${UNIT}: PROVEN`);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.brief).toContain(`Modernize unit ${UNIT} to python3`);
    expect(Object.keys(stub.converted)).toEqual(PY2_FILES);
    expect(stub.converted["legacy/report.py"]).toContain('print("total", total)');
    // Every converted file is valid python3, and the converted print function really prints.
    for (const [rel, text] of Object.entries(stub.converted)) {
      const c = spawnSync("python3", ["-I", "-c", "import sys; compile(sys.stdin.read(), sys.argv[1], 'exec')", rel], { input: text, encoding: "utf8" });
      expect(c.status).toBe(0);
    }
    const run = spawnSync("python3", ["-I", "-c", "exec(compile(open(0).read(), 'report.py', 'exec')); show(3)"], { input: stub.converted["legacy/report.py"]!, encoding: "utf8" });
    expect(run.stdout).toBe("total 3\n\n");
    expect(r.result!.verdict).toBe("PROVEN");
    expect(r.result!.oracle!.case_count).toBe(10);
    expect(r.result!.conformance).toEqual({ trust: "runner_reported", limit: "FC-24", tests: 2 });
    expect(r.conformance.length).toBe(2);
    expect(r.conformance[0]).not.toBe(0); // base red
    expect(r.conformance[1]).toBe(0); // modernized tree green under python3
    expect(r.sealedExists).toBe(true);
    expect(r.events.indexOf("wall.presealed.sealed")).toBeGreaterThanOrEqual(0);
    expect(r.events.some((t) => t === "oracle.captured")).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith("loki-unit-"))).toEqual([]); // run-owned checkout removed
    expect(readFileSync(join(repo, UNIT_FILE), "utf8")).toContain("iteritems"); // the source repo itself is untouched
  });

  it.skipIf(SKIP_REASON !== "")("a broken transform step is never PROVEN (exit 1, reason on stderr)", async () => {
    const noIter = (s: string) => py2to3(s).replace(".items()", ".iteritems()"); // iteritems step dropped
    const r1 = await driveUnit(stubProvider(noIter));
    expect(r1.code).toBe(1);
    expect(r1.out).not.toContain("PROVEN");
    expect(r1.result!.verdict).not.toBe("PROVEN");
    expect(r1.err).toMatch(/NOT_(PROVEN|EQUAL)/);

    const wrongValue = (s: string) => py2to3(s).replace("return total", "return total + 1"); // behavior drift the oracle must catch
    const r2 = await driveUnit(stubProvider(wrongValue));
    expect(r2.code).toBe(1);
    expect(r2.result!.verdict).not.toBe("PROVEN");
  });

  it.skipIf(SKIP_REASON !== "")("an unrunnable replay interpreter fails closed, never a vacuous PROVEN", async () => {
    const r = await driveUnit(stubProvider(py2to3), { pythonBin: join(root, "no-such-python") });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("PROVEN");
    expect(r.result!.verdict).not.toBe("PROVEN");
    expect(r.err).toContain(UNIT);
  });
});

describe("e2e host prerequisites", () => {
  it("reports the named reason when python3 with pytest is missing, otherwise confirms it", () => {
    if (SKIP_REASON) { expect(SKIP_REASON).toBe("python3 with pytest is not available on this host"); return; }
    expect(pyProbe.status).toBe(0);
    expect(pyProbe.stdout + pyProbe.stderr).toMatch(/pytest/i);
  });
});
