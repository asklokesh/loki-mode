// loki-ts/tests/metrics/trust.test.ts -- R4 trust trajectory regression tests.
//
// Covers (mirrors tests/test_trust_trajectory.py for cross-route parity):
//  - aggregation from fixture proof.json files
//  - direction calc up / down / flat per axis polarity
//  - insufficient-history (<2 runs) -> insufficient, no fabricated trend
//  - intervention axis available=false until a proof carries it
//  - malformed proof.json skipped, not fatal
//  - no-PII: secrets in spec/diffs/summary never surface in output
//  - JSON/human formatting are stable and parseable
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTrajectory,
  formatTrajectoryJson,
  formatTrajectoryHuman,
} from "../../src/metrics/trust.ts";

let td: string;

beforeEach(() => {
  td = mkdtempSync(join(tmpdir(), "loki-trust-"));
});
afterEach(() => {
  rmSync(td, { recursive: true, force: true });
});

type ProofOpts = {
  generatedAt: string;
  finalVerdict?: string;
  gatesPassed?: number;
  gatesTotal?: number;
  iterations?: number;
  interventions?: number;
  reviewers?: Array<{ vote: string }>;
  raw?: Record<string, unknown>;
};

function writeProof(runId: string, opts: ProofOpts): void {
  const d = join(td, "proofs", runId);
  mkdirSync(d, { recursive: true });
  let proof: Record<string, unknown>;
  if (opts.raw) {
    proof = opts.raw;
  } else {
    const council: Record<string, unknown> = { enabled: true };
    if (opts.finalVerdict !== undefined) council["final_verdict"] = opts.finalVerdict;
    if (opts.reviewers !== undefined) council["reviewers"] = opts.reviewers;
    if (opts.interventions !== undefined) council["interventions"] = opts.interventions;
    const qg: Record<string, unknown> = {};
    if (opts.gatesPassed !== undefined && opts.gatesTotal !== undefined) {
      qg["passed"] = opts.gatesPassed;
      qg["total"] = opts.gatesTotal;
    }
    proof = {
      schema_version: "1.0",
      run_id: runId,
      generated_at: opts.generatedAt,
      council,
      quality_gates: qg,
    };
    if (opts.iterations !== undefined) proof["iterations"] = { count: opts.iterations };
  }
  writeFileSync(join(d, "proof.json"), JSON.stringify(proof));
}

describe("computeTrajectory: insufficient history", () => {
  it("no proofs dir -> insufficient with note", () => {
    const traj = computeTrajectory(td);
    expect(traj.runs_count).toBe(0);
    expect(traj.insufficient).toBe(true);
    expect(traj.notes.join(" ")).toContain("not enough history");
  });

  it("single run -> insufficient, axes flat with insufficient flag", () => {
    writeProof("r1", {
      generatedAt: "2026-06-01T00:00:00Z",
      finalVerdict: "APPROVED",
      gatesPassed: 5,
      gatesTotal: 5,
      iterations: 3,
    });
    const traj = computeTrajectory(td);
    expect(traj.runs_count).toBe(1);
    expect(traj.insufficient).toBe(true);
    const cp = traj.axes.council_pass_rate;
    expect(cp.available).toBe(true);
    expect(cp.insufficient).toBe(true);
    expect(cp.direction).toBe("flat");
    expect(cp.improving).toBe(null);
  });
});

describe("computeTrajectory: direction up", () => {
  it("council pass-rate rising is improving", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "REJECTED" });
    writeProof("r2", { generatedAt: "2026-06-02T00:00:00Z", finalVerdict: "REJECTED" });
    writeProof("r3", { generatedAt: "2026-06-03T00:00:00Z", finalVerdict: "APPROVED" });
    writeProof("r4", { generatedAt: "2026-06-04T00:00:00Z", finalVerdict: "APPROVED" });
    const traj = computeTrajectory(td);
    expect(traj.insufficient).toBe(false);
    const cp = traj.axes.council_pass_rate;
    expect(cp.direction).toBe("up");
    expect(cp.improving).toBe(true);
    expect(cp.delta).toBeGreaterThan(0);
    expect(traj.improving_axes).toContain("council_pass_rate");
  });

  it("gate pass-rate rising is improving", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", gatesPassed: 1, gatesTotal: 4 });
    writeProof("r2", { generatedAt: "2026-06-02T00:00:00Z", gatesPassed: 4, gatesTotal: 4 });
    const g = computeTrajectory(td).axes.gate_pass_rate;
    expect(g.direction).toBe("up");
    expect(g.improving).toBe(true);
  });
});

describe("computeTrajectory: direction down", () => {
  it("fewer iterations over time is improving (lower is better)", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", iterations: 10 });
    writeProof("r2", { generatedAt: "2026-06-02T00:00:00Z", iterations: 8 });
    writeProof("r3", { generatedAt: "2026-06-03T00:00:00Z", iterations: 4 });
    writeProof("r4", { generatedAt: "2026-06-04T00:00:00Z", iterations: 3 });
    const it = computeTrajectory(td).axes.iterations;
    expect(it.direction).toBe("down");
    expect(it.improving).toBe(true);
  });

  it("council pass-rate falling is regressing", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "APPROVED" });
    writeProof("r2", { generatedAt: "2026-06-02T00:00:00Z", finalVerdict: "REJECTED" });
    const traj = computeTrajectory(td);
    const cp = traj.axes.council_pass_rate;
    expect(cp.direction).toBe("down");
    expect(cp.improving).toBe(false);
    expect(traj.regressing_axes).toContain("council_pass_rate");
  });
});

describe("computeTrajectory: direction flat", () => {
  it("constant values are flat with null improving", () => {
    for (let i = 1; i <= 4; i++) {
      writeProof(`r${i}`, {
        generatedAt: `2026-06-0${i}T00:00:00Z`,
        finalVerdict: "APPROVED",
        gatesPassed: 5,
        gatesTotal: 5,
        iterations: 4,
      });
    }
    const traj = computeTrajectory(td);
    for (const axis of ["council_pass_rate", "gate_pass_rate", "iterations"] as const) {
      expect(traj.axes[axis].direction).toBe("flat");
      expect(traj.axes[axis].improving).toBe(null);
    }
  });
});

describe("computeTrajectory: interventions axis", () => {
  it("unavailable when not recorded", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "APPROVED" });
    writeProof("r2", { generatedAt: "2026-06-02T00:00:00Z", finalVerdict: "APPROVED" });
    const traj = computeTrajectory(td);
    expect(traj.axes.interventions.available).toBe(false);
    expect(traj.notes.join(" ")).toContain("intervention trend unavailable");
  });

  it("available and decreasing when recorded", () => {
    writeProof("r1", {
      generatedAt: "2026-06-01T00:00:00Z",
      finalVerdict: "APPROVED",
      interventions: 5,
    });
    writeProof("r2", {
      generatedAt: "2026-06-02T00:00:00Z",
      finalVerdict: "APPROVED",
      interventions: 1,
    });
    const iv = computeTrajectory(td).axes.interventions;
    expect(iv.available).toBe(true);
    expect(iv.direction).toBe("down");
    expect(iv.improving).toBe(true);
  });
});

describe("computeTrajectory: reviewer fallback", () => {
  it("uses reviewers when no final_verdict", () => {
    writeProof("r1", {
      generatedAt: "2026-06-01T00:00:00Z",
      reviewers: [{ vote: "APPROVE" }, { vote: "REJECT" }],
    });
    writeProof("r2", {
      generatedAt: "2026-06-02T00:00:00Z",
      reviewers: [{ vote: "APPROVE" }, { vote: "APPROVE" }],
    });
    const cp = computeTrajectory(td).axes.council_pass_rate;
    expect(cp.direction).toBe("up");
    expect(cp.improving).toBe(true);
  });
});

describe("computeTrajectory: robustness", () => {
  it("skips malformed proof.json", () => {
    writeProof("good1", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "APPROVED" });
    writeProof("good2", { generatedAt: "2026-06-02T00:00:00Z", finalVerdict: "APPROVED" });
    const bad = join(td, "proofs", "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "proof.json"), "{not valid json");
    const traj = computeTrajectory(td);
    expect(traj.runs_count).toBe(2);
  });

  it("orders runs ascending by generated_at", () => {
    writeProof("later", { generatedAt: "2026-06-09T00:00:00Z", finalVerdict: "APPROVED" });
    writeProof("earlier", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "REJECTED" });
    const ids = computeTrajectory(td).series.map((s) => s.run_id);
    expect(ids).toEqual(["earlier", "later"]);
  });
});

describe("computeTrajectory: no PII", () => {
  it("never surfaces secret spec/diff/summary text", () => {
    const secret = "API_KEY=sk-do-not-leak-12345";
    writeProof("r1", {
      generatedAt: "2026-06-01T00:00:00Z",
      raw: {
        run_id: "r1",
        generated_at: "2026-06-01T00:00:00Z",
        spec: { text: secret, source: "/home/u/secret.md" },
        diffs: [secret],
        council: { enabled: true, final_verdict: "APPROVED", reviewers: [{ summary: secret }] },
        quality_gates: { passed: 5, total: 5 },
        iterations: { count: 3 },
      },
    });
    writeProof("r2", {
      generatedAt: "2026-06-02T00:00:00Z",
      raw: {
        run_id: "r2",
        generated_at: "2026-06-02T00:00:00Z",
        spec: { text: secret },
        council: { enabled: true, final_verdict: "APPROVED" },
        quality_gates: { passed: 5, total: 5 },
        iterations: { count: 2 },
      },
    });
    const traj = computeTrajectory(td);
    const blob = formatTrajectoryJson(traj);
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain("sk-do-not-leak");
    expect(blob).not.toContain("/home/u/secret.md");
    expect(blob).not.toContain("API_KEY");
    expect(formatTrajectoryHuman(traj)).not.toContain(secret);
    const allowed = new Set([
      "run_id",
      "generated_at",
      "council_pass_rate",
      "gate_pass_rate",
      "iterations",
      "interventions",
    ]);
    for (const row of traj.series) {
      for (const k of Object.keys(row)) {
        expect(allowed.has(k)).toBe(true);
      }
    }
  });
});

describe("formatting", () => {
  it("JSON is parseable and schema-versioned", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "APPROVED" });
    writeProof("r2", { generatedAt: "2026-06-02T00:00:00Z", finalVerdict: "APPROVED" });
    const parsed = JSON.parse(formatTrajectoryJson(computeTrajectory(td)));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.axes).toBeDefined();
    expect(parsed.series).toBeDefined();
  });

  it("human output has headline and axis labels", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "REJECTED", gatesPassed: 2, gatesTotal: 4 });
    writeProof("r2", { generatedAt: "2026-06-02T00:00:00Z", finalVerdict: "APPROVED", gatesPassed: 4, gatesTotal: 4 });
    const human = formatTrajectoryHuman(computeTrajectory(td));
    expect(human).toContain("Trust Trajectory");
    expect(human).toContain("Council pass rate");
    expect(human).toContain("Gate pass rate");
  });

  it("insufficient human output says not enough", () => {
    writeProof("r1", { generatedAt: "2026-06-01T00:00:00Z", finalVerdict: "APPROVED" });
    const human = formatTrajectoryHuman(computeTrajectory(td));
    expect(human).toContain("Not enough history yet");
  });
});
