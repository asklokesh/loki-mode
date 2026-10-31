// loki-ts/tests/commands/trust.test.ts -- runTrust command wrapper contract.
//
// Covers: help forms (exit 0 + usage text), unknown-arg hint on stderr (exit 1),
// --json parseable output against an empty .loki, the writeTrajectoryCache side
// effect, a seeded two-run proofs fixture (non-flat trajectory), and the
// honest-data rule (fewer than 2 runs yields no fabricated trend).
//
// Hermetic: LOKI_DIR points at a tmpdir; stdout/stderr are monkey-patched.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runTrust } from "../../src/commands/trust.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../src/util/paths.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function run(args: string[], stdin?: string): { code: number; stdout: string; stderr: string } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  const dec = (c: unknown): string =>
    typeof c === "string" ? c : new TextDecoder().decode(c as Uint8Array);
  process.stdout.write = ((c: unknown): boolean => {
    out += dec(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown): boolean => {
    err += dec(c);
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = runTrust(args, stdin);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout: out, stderr: err };
}

let td: string;
let lokiDir: string;
let savedLokiDir: string | undefined;

function seedProof(runId: string, at: string, passed: number, total: number, iters: number): void {
  const d = join(lokiDir, "proofs", runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "proof.json"),
    JSON.stringify({
      run_id: runId,
      generated_at: at,
      council: { final_verdict: passed === total ? "APPROVED" : "REJECTED" },
      quality_gates: { total, passed },
      iterations: { count: iters },
    }),
  );
}

beforeEach(() => {
  td = mkdtempSync(join(tmpdir(), "loki-trust-cmd-"));
  lokiDir = join(td, ".loki");
  savedLokiDir = process.env["LOKI_DIR"];
  process.env["LOKI_DIR"] = lokiDir;
});
afterEach(() => {
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
  rmSync(td, { recursive: true, force: true });
});

describe("runTrust", () => {
  for (const flag of ["--help", "-h", "help"]) {
    it(`${flag} returns 0 and prints usage`, () => {
      const r = run([flag]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("visible trust trajectory");
      expect(r.stderr).toBe("");
    });
  }

  it("unknown arg returns 1 with the hint on stderr", () => {
    const r = run(["--bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Run 'loki trust --help'");
    expect(r.stdout).toBe("");
  });

  it("--json on an empty .loki returns 0 with parseable insufficient JSON and writes the cache", () => {
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.runs_count).toBe(0);
    expect(j.insufficient).toBe(true);
    const cache = join(lokiDir, "metrics", "trust-trajectory.json");
    expect(existsSync(cache)).toBe(true);
    expect(JSON.parse(readFileSync(cache, "utf8")).runs_count).toBe(0);
  });

  it("one run yields no fabricated trend", () => {
    seedProof("run-a", "2026-01-01T00:00:00Z", 4, 8, 10);
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.runs_count).toBe(1);
    expect(j.insufficient).toBe(true);
    expect(j.improving_count).toBe(0);
    expect(j.regressing_count).toBe(0);
    expect(j.axes.gate_pass_rate.insufficient).toBe(true);
    expect(j.axes.gate_pass_rate.improving).not.toBe(true);
  });

  it("two seeded runs yield a non-flat improving trajectory", () => {
    seedProof("run-a", "2026-01-01T00:00:00Z", 4, 8, 10);
    seedProof("run-b", "2026-01-02T00:00:00Z", 8, 8, 4);
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.runs_count).toBe(2);
    expect(j.insufficient).toBe(false);
    expect(j.axes.gate_pass_rate.direction).toBe("up");
    expect(j.axes.gate_pass_rate.improving).toBe(true);
    expect(j.axes.iterations.direction).toBe("down");
    expect(j.axes.iterations.improving).toBe(true);
    expect(j.improving_axes).toContain("gate_pass_rate");
    const cached = JSON.parse(
      readFileSync(join(lokiDir, "metrics", "trust-trajectory.json"), "utf8"),
    );
    expect(cached.runs_count).toBe(2);
  });

  it("human mode prints non-empty text and returns 0", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});

describe("runTrust graduation advice", () => {
  it("--json carries graduation, reads level read-only, never writes policies.json", () => {
    mkdirSync(lokiDir, { recursive: true });
    const pol = join(lokiDir, "policies.json");
    writeFileSync(pol, JSON.stringify({ autonomy: "propose" }));
    const before = readFileSync(pol, "utf8");
    seedProof("run-a", "2026-01-01T00:00:00Z", 4, 8, 10);
    const r = run(["--json"]);
    const j = JSON.parse(r.stdout);
    expect(j.graduation.current_level).toBe("propose");
    expect(j.graduation.eligible).toBe(false);
    expect(readFileSync(pol, "utf8")).toBe(before);
  });
  it("human output shows the advisory line without a policy file and creates none", () => {
    const r = run([]);
    expect(r.stdout).toContain("Autonomy advice (advisory, never changes policy)");
    expect(existsSync(join(lokiDir, "policies.json"))).toBe(false);
  });

  describe("README badge snippet", () => {
    function seedHeadline(runId: string, headline: string): void {
      const f = join(lokiDir, "proofs", runId, "proof.json");
      const d = JSON.parse(readFileSync(f, "utf8"));
      d.honesty = { headline };
      writeFileSync(f, JSON.stringify(d));
    }
    it("prints a markdown badge for the newest sealed run", () => {
      seedProof("r1", "2026-01-01T00:00:00Z", 8, 8, 3);
      seedProof("r2", "2026-01-02T00:00:00Z", 8, 8, 3);
      seedHeadline("r1", "NOT VERIFIED");
      seedHeadline("r2", "VERIFIED");
      const r = run([]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("![Verified by Loki](https://img.shields.io/badge/Loki-Verified%20by%20Loki-brightgreen)");
      expect(r.stdout).not.toContain("Not%20verified");
    });
    it("skips unrecognized headlines and never goes green on them", () => {
      seedProof("r1", "2026-01-01T00:00:00Z", 8, 8, 3);
      seedHeadline("r1", "SORTA GREEN");
      const r = run([]);
      expect(r.stdout).not.toContain("img.shields.io");
      expect(r.stdout).toContain("run 'loki start'");
    });
    it("prints the next step with no proofs and keeps --json clean", () => {
      const r = run([]);
      expect(r.stdout).toContain("No README badge yet");
      expect(run(["--json"]).stdout).not.toContain("badge");
    });
  });
});

describe("runTrust per-path Seal record", () => {
  function git(...a: string[]): void {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...a], { cwd: td, stdio: "ignore" });
  }
  function seedPathProof(runId: string, headline: string, paths: string[]): void {
    const d = join(lokiDir, "proofs", runId);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "proof.json"),
      JSON.stringify({ run_id: runId, generated_at: "2026-01-01T00:00:00Z", honesty: { headline }, files_changed: { files: paths.map((path) => ({ path })) } }),
    );
  }

  it("reports 20 VERIFIED / 0 reverts for one path and flips a reverted path to 1", () => {
    git("init", "-q");
    writeFileSync(join(td, "a.txt"), "a\n");
    writeFileSync(join(td, "b.txt"), "b\n");
    git("add", "a.txt", "b.txt");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(td, "b.txt"), "b2\n");
    git("commit", "-q", "-am", "change b");
    git("revert", "--no-edit", "HEAD");
    for (let i = 0; i < 20; i++) seedPathProof(`run-a-${String(i).padStart(2, "0")}`, "VERIFIED", ["a.txt"]);
    seedPathProof("run-b-00", "VERIFIED", ["b.txt"]);
    seedPathProof("run-b-01", "PARTIAL", ["b.txt"]);
    const j = JSON.parse(run(["--json"]).stdout);
    const by = Object.fromEntries(j.path_seals.map((x: { path: string }) => [x.path, x]));
    expect(by["a.txt"]).toEqual({ path: "a.txt", verified: 20, other: 0, reverts: 0 });
    expect(by["b.txt"]).toEqual({ path: "b.txt", verified: 1, other: 1, reverts: 1 });
  });

  it("a proof written by the real generator for a repo change shows its path in loki trust", () => {
    git("init", "-q");
    writeFileSync(join(td, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    mkdirSync(lokiDir, { recursive: true });
    writeFileSync(join(td, "feature.txt"), "new work\n");
    git("add", "feature.txt");
    git("commit", "-q", "-m", "add feature");
    const gen = resolve(REPO_ROOT, "autonomy", "lib", "proof-generator.py");
    const g = spawnSync("python3", [gen, "--loki-dir", lokiDir, "--run-id", "real-writer-1", "--quiet"], { cwd: td, encoding: "utf8" });
    expect(g.status).toBe(0);
    expect(existsSync(join(lokiDir, "proofs", "real-writer-1", "proof.json"))).toBe(true);
    const j = JSON.parse(run(["--json"]).stdout);
    const hit = j.path_seals.find((x: { path: string }) => x.path === "feature.txt");
    expect(hit).toBeDefined();
    expect(hit.verified + hit.other).toBe(1);
    expect(hit.reverts).toBe(0);
  });

  it("reverts are null (unknown) outside a git repo, never a fabricated 0", () => {
    seedPathProof("run-x", "VERIFIED", ["x.txt"]);
    const j = JSON.parse(run(["--json"]).stdout);
    expect(j.path_seals).toEqual([{ path: "x.txt", verified: 1, other: 0, reverts: null }]);
  });

  it("a reverted merge counts reverts for a non-ASCII path and a path with a space (no quoted-path false zero)", () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(td, "m.txt"), "m\n");
    git("add", "m.txt");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "loki/s1");
    writeFileSync(join(td, "é.txt"), "e\n");
    writeFileSync(join(td, "with space.txt"), "s\n");
    git("add", "é.txt", "with space.txt");
    git("commit", "-q", "-m", "add files");
    git("checkout", "-q", "main");
    git("merge", "--no-ff", "-q", "-m", "merge s1", "loki/s1");
    git("revert", "-m", "1", "--no-edit", "HEAD");
    seedPathProof("run-u-00", "VERIFIED", ["é.txt", "with space.txt"]);
    const j = JSON.parse(run(["--json"]).stdout);
    const by = Object.fromEntries(j.path_seals.map((x: { path: string }) => [x.path, x]));
    expect(by["é.txt"].reverts).toBe(1);
    expect(by["with space.txt"].reverts).toBe(1);
  });

  it("reverts are null (unknown), never 0, when a revert commit cannot be read", () => {
    git("init", "-q");
    writeFileSync(join(td, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(td, "b.txt"), "b2\n");
    git("commit", "-q", "-am", "change b");
    git("revert", "--no-edit", "HEAD");
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: td, encoding: "utf8" }).trim();
    rmSync(join(td, ".git", "objects", tree.slice(0, 2), tree.slice(2)), { force: true });
    seedPathProof("run-r-00", "VERIFIED", ["b.txt"]);
    const j = JSON.parse(run(["--json"]).stdout);
    expect(j.path_seals).toEqual([{ path: "b.txt", verified: 1, other: 0, reverts: null }]);
  });

  it("reverts are null (unknown), never 0, in a shallow clone that cut off an old revert", () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(td, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(td, "b.txt"), "b2\n");
    git("commit", "-q", "-am", "change b");
    git("revert", "--no-edit", "HEAD");
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(td, "c.txt"), `c${i}\n`);
      git("add", "c.txt");
      git("commit", "-q", "-m", `later ${i}`);
    }
    const clone = mkdtempSync(join(tmpdir(), "trust-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", `file://${td}`, clone], { stdio: "ignore" });
      const d = join(clone, ".loki", "proofs", "run-s-00");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "proof.json"), JSON.stringify({ run_id: "run-s-00", honesty: { headline: "VERIFIED" }, files_changed: { files: [{ path: "b.txt" }] } }));
      process.env.LOKI_DIR = join(clone, ".loki");
      const j = JSON.parse(run(["--json"]).stdout);
      expect(j.path_seals).toEqual([{ path: "b.txt", verified: 1, other: 0, reverts: null }]);
    } finally {
      process.env.LOKI_DIR = lokiDir;
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("human output lists the per-path record", () => {
    seedPathProof("run-x", "VERIFIED", ["x.txt"]);
    expect(run([]).stdout).toContain("x.txt: 1 of 20 VERIFIED, 0 other, reverts unknown");
  });

  describe("earned-merge progress", () => {
    function seedRepo(): void {
      git("init", "-q");
      writeFileSync(join(td, "keep.txt"), "k\n");
      writeFileSync(join(td, "gone.txt"), "g\n");
      git("add", "keep.txt", "gone.txt");
      git("commit", "-q", "-m", "base");
      writeFileSync(join(td, "gone.txt"), "g2\n");
      git("commit", "-q", "-am", "change gone");
      git("revert", "--no-edit", "HEAD");
    }
    function seedMany(path: string, n: number, headline = "VERIFIED"): void {
      for (let i = 0; i < n; i++) seedPathProof(`run-${path.replace(/\W/g, "_")}-${String(i).padStart(2, "0")}`, headline, [path]);
    }
    function row(out: string, path: string): string {
      const l = out.split("\n").find((x) => x.startsWith(`  ${path}: `));
      expect(l).toBeDefined();
      return l as string;
    }

    it("shows progress toward the threshold with the number of receipts still needed", () => {
      seedRepo();
      seedMany("src/api/x.ts", 12);
      expect(row(run([]).stdout, "src/api/x.ts")).toBe("  src/api/x.ts: 12 of 20 VERIFIED, 0 other, 0 reverts, 8 more needed");
    });

    it("honours the owner's minimum and marks a met path eligible", () => {
      seedRepo();
      seedMany("keep.txt", 3);
      process.env.LOKI_EARNED_MERGE_MIN_VERIFIED = "3";
      try {
        expect(row(run([]).stdout, "keep.txt")).toBe("  keep.txt: 3 of 3 VERIFIED, 0 other, 0 reverts, eligible for earned merge");
      } finally {
        delete process.env.LOKI_EARNED_MERGE_MIN_VERIFIED;
      }
    });

    it("says why a path is refused: protected, reverted, reverts unknown", () => {
      seedRepo();
      seedMany(".github/w.yml", 25);
      seedMany("gone.txt", 25);
      expect(row(run([]).stdout, ".github/w.yml")).toContain("refused: protected path");
      expect(row(run([]).stdout, "gone.txt")).toContain("1 reverts, refused: reverted in git history");
      rmSync(join(td, ".git"), { recursive: true, force: true });
      seedMany("other.txt", 25);
      expect(row(run([]).stdout, "other.txt")).toContain("reverts unknown, refused: reverts unknown (shallow clone or unreadable history)");
    });

    it("the display and the merge gate decision agree for every path", () => {
      seedRepo();
      const paths = ["keep.txt", "gone.txt", ".github/w.yml", ".ENV.local", "src/auth/deep.ts", "docs/CODEOWNERS", "low.txt", "at-floor.txt"];
      seedMany("keep.txt", 25);
      seedMany("gone.txt", 25);
      seedMany(".github/w.yml", 25);
      seedMany(".ENV.local", 25);
      seedMany("src/auth/deep.ts", 25);
      seedMany("docs/CODEOWNERS", 25);
      seedMany("low.txt", 19);
      seedMany("at-floor.txt", 20);
      process.env.LOKI_EARNED_MERGE_PROTECTED = "src/auth/*";
      try {
        const shown = run([]).stdout;
        const gate = run(["--check"], [...paths, "never-sealed.txt"].join("\n") + "\n").stdout.trim().split("\n");
        expect(gate.length).toBe(paths.length + 1);
        const verdict = new Map(gate.map((l) => [l.split("\t")[1], l.split("\t")[0]]));
        for (const p of paths) {
          const displayedEligible = row(shown, p).endsWith("eligible for earned merge");
          expect(verdict.get(p) === "ok").toBe(displayedEligible);
        }
        expect(paths.filter((p) => verdict.get(p) === "ok")).toEqual(["keep.txt", "at-floor.txt"]);
        expect(verdict.get("never-sealed.txt")).toBe("refuse");
        expect(gate.find((l) => l.includes("never-sealed.txt"))).toContain("never-sealed.txt has no Seal record");
        expect(gate.find((l) => l.includes("low.txt"))).toContain("low.txt has 19 VERIFIED receipts, need 20");
      } finally {
        delete process.env.LOKI_EARNED_MERGE_PROTECTED;
      }
    });
  });
});
