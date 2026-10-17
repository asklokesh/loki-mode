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
      "verdict",
      "false_verified",
      "cost_usd",
      "interventions_by_type",
      "waited_s",
      "active_s",
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

import { graduationAdvice, outcomeEffort, type TrustRun } from "../../src/metrics/trust.ts";

function gRun(i: number, over: Partial<TrustRun> = {}): TrustRun {
  return {
    run_id: `r${i}`, generated_at: null, council_pass_rate: 1, gate_pass_rate: 1,
    iterations: 3, interventions: 0, verdict: "VERIFIED", cost_usd: null, interventions_by_type: null, waited_s: null, active_s: null, false_verified: false, ...over,
  };
}

describe("graduationAdvice", () => {
  const ten = Array.from({ length: 12 }, (_, i) => gRun(i));
  it("eligible: 12 clean runs, no regression", () => {
    const a = graduationAdvice({ series: ten, regressing_axes: [] }, "propose");
    expect(a.eligible).toBe(true);
    expect(a.next_level).toBe("execute");
    expect(a.summary).toContain("eligible for execute: 12 runs, 0 false VERIFIED, council pass 100%");
  });
  it("too few runs", () => {
    const a = graduationAdvice({ series: ten.slice(0, 4), regressing_axes: [] }, "propose");
    expect(a.eligible).toBe(false);
    expect(a.missing[0]).toContain("need 10+ runs, have 4");
  });
  it("runs without verdict evidence are UNCHECKED, not eligible", () => {
    const s = ten.map((r) => ({ ...r, verdict: null, false_verified: null }));
    const a = graduationAdvice({ series: s, regressing_axes: [] }, "propose");
    expect(a.eligible).toBe(false);
    expect(a.missing[0]).toContain("UNCHECKED");
  });
  it("all-FAILED verdicts are not eligible", () => {
    const s = Array.from({ length: 10 }, (_, i) => gRun(i, { verdict: "FAILED", council_pass_rate: 0, gate_pass_rate: 0 }));
    const a = graduationAdvice({ series: s, regressing_axes: [] }, "propose");
    expect(a.eligible).toBe(false);
    expect(a.summary).toContain("not yet eligible for execute");
    expect(a.missing.join()).toContain("10 run(s) with a non-VERIFIED verdict");
  });
  it("6 VERIFIED + 4 FAILED is not eligible", () => {
    const s = Array.from({ length: 10 }, (_, i) => gRun(i, i < 6 ? {} : { verdict: "FAILED" }));
    const a = graduationAdvice({ series: s, regressing_axes: [] }, "propose");
    expect(a.eligible).toBe(false);
    expect(a.missing.join()).toContain("have 6");
    expect(a.missing.join()).toContain("4 run(s) with a non-VERIFIED verdict");
  });
  it("a false VERIFIED blocks", () => {
    const s = [...ten.slice(1), gRun(99, { false_verified: true })];
    expect(graduationAdvice({ series: s, regressing_axes: [] }, "execute").eligible).toBe(false);
  });
  it("a regressing axis blocks", () => {
    const a = graduationAdvice({ series: ten, regressing_axes: ["gate_pass_rate"] }, "propose");
    expect(a.eligible).toBe(false);
    expect(a.missing.join()).toContain("regressing: gate_pass_rate");
  });
  it("operate has no next level", () => {
    const a = graduationAdvice({ series: ten, regressing_axes: [] }, "operate");
    expect(a.eligible).toBe(false);
    expect(a.next_level).toBeNull();
  });
});

describe("computeTrajectory: outcome effort", () => {
  const raw = (id: string, extra: Record<string, unknown>) =>
    writeProof(id, {
      generatedAt: `2026-06-0${id.slice(1)}T00:00:00Z`,
      raw: { run_id: id, generated_at: `2026-06-0${id.slice(1)}T00:00:00Z`, ...extra },
    });
  const detail = (input: number, auth: number, waited: number) => ({
    interventions_detail: {
      by_type: { steer: 0, input, authorization: auth, repair: 0 },
      waited_s: waited,
    },
  });

  it("mixed fixture: honest-null cost, misleading 1/3, by_type totals", () => {
    raw("r1", { verdict: "VERIFIED", cost: { usd: 1 }, interventions: 1, ...detail(1, 0, 120) });
    raw("r2", { verdict: "VERIFIED", cost: { usd: 2 }, interventions: 0, ...detail(0, 0, 0) });
    raw("r3", { verdict: "VERIFIED", later_verdict: "FAILED", cost: { usd: 3 }, interventions: 1, ...detail(0, 1, 60) });
    raw("r4", { verdict: "FAILED", interventions: 0, ...detail(0, 0, 0) });
    const eff = computeTrajectory(td).outcome_effort;
    expect(eff.accepted).toBe(2);
    expect(eff.claimed_verified).toBe(3);
    expect(eff.false_verified).toBe(1);
    expect(eff.misleading_completion_rate).toBeCloseTo(1 / 3, 3);
    expect(eff.cost_per_accepted_usd).toBeNull();
    expect(eff.cost_note).toContain("unmeasured");
    expect(eff.interventions_by_type).toEqual({ steer: 0, input: 1, authorization: 1, repair: 0 });
    expect(eff.interventions_per_accepted).toBe(1);
    expect(eff.waited_min_per_accepted).toBe(1.5);
    const human = formatTrajectoryHuman(computeTrajectory(td));
    expect(human).toContain("Outcome effort");
    expect(human).toContain("waited, upper bound");
  });

  it("active minutes per accepted are reported only when every run measured them", () => {
    const withActive = (id: string, active?: number) =>
      raw(id, {
        verdict: "VERIFIED",
        ...detail(1, 0, 600),
        ...(active === undefined
          ? {}
          : { interventions_detail: { by_type: { steer: 0, input: 1, authorization: 0, repair: 0 }, waited_s: 600, active_s: active } }),
      });
    withActive("r1", 90);
    withActive("r2", 30);
    const eff = computeTrajectory(td).outcome_effort;
    expect(eff.active_min_per_accepted).toBe(1);
    expect(eff.waited_min_per_accepted).toBe(10);
    const human = formatTrajectoryHuman(computeTrajectory(td));
    expect(human).toContain("Active minutes per accepted: 1");
    withActive("r3");
    const eff2 = computeTrajectory(td).outcome_effort;
    expect(eff2.active_min_per_accepted).toBeNull();
    expect(formatTrajectoryHuman(computeTrajectory(td))).toContain("Active minutes per accepted: n/a (not measured)");
  });

  it("a malformed active_s (float, negative) is unmeasured, not 0", () => {
    for (const [i, bad] of [1.5, -1].entries()) {
      raw(`r${i + 1}`, {
        verdict: "VERIFIED",
        interventions_detail: { by_type: { steer: 0, input: 1, authorization: 0, repair: 0 }, waited_s: 60, active_s: bad },
      });
    }
    expect(computeTrajectory(td).outcome_effort.active_min_per_accepted).toBeNull();
  });

  it("cost per accepted is total spend over all attempts / accepted", () => {
    raw("r1", { verdict: "VERIFIED", cost: { usd: 1 } });
    raw("r2", { verdict: "FAILED", cost: { usd: 3 } });
    const eff = computeTrajectory(td).outcome_effort;
    expect(eff.cost_per_accepted_usd).toBe(4);
    expect(eff.interventions_per_accepted).toBeNull();
    expect(eff.waited_min_per_accepted).toBeNull();
    expect(eff.interventions_by_type).toBeNull();
  });

  it("no accepted run: null with note, no claimed: null rate", () => {
    raw("r1", { verdict: "FAILED", cost: { usd: 1 } });
    const eff = computeTrajectory(td).outcome_effort;
    expect(eff.cost_per_accepted_usd).toBeNull();
    expect(eff.cost_note).toContain("no accepted");
    expect(eff.misleading_completion_rate).toBeNull();
  });
});

describe("outcomeEffort partial cost", () => {
  it("refuses a bare cost per accepted when any run cost is partial", () => {
    const e = outcomeEffort([gRun(0, { cost_usd: 0.5 }), gRun(1, { cost_usd: 0.5, cost_partial: true })]);
    expect(e.cost_per_accepted_usd).toBeNull();
    expect(e.cost_note).toContain("cost partial for 1 of 2 runs");
  });
  it("still reports complete cost", () => {
    const e = outcomeEffort([gRun(0, { cost_usd: 0.5, cost_partial: false })]);
    expect(e.cost_per_accepted_usd).toBe(0.5);
  });
});

describe("computeTrajectory partial cost parity with trust_trajectory.py", () => {
  it("loads cost_partial from proofs and refuses a bare cost per accepted", () => {
    for (const id of ["r0", "r1"]) {
      writeProof(id, {
        generatedAt: "2026-01-01T00:00:00Z",
        raw: { run_id: id, verdict: "VERIFIED", cost: { usd: 0.5, cost_partial: true } },
      });
    }
    const traj = computeTrajectory(td);
    expect(traj.outcome_effort.cost_per_accepted_usd).toBeNull();
    expect(traj.outcome_effort.cost_note).toContain("cost partial for 2 of 2 runs");
    expect(formatTrajectoryHuman(traj)).not.toContain("Cost per accepted: $");
  });
  it("unpriced records alone mark the run partial", () => {
    writeProof("r0", {
      generatedAt: "2026-01-01T00:00:00Z",
      raw: { run_id: "r0", verdict: "VERIFIED", cost: { usd: 0.5, cost_unpriced_records: 2 } },
    });
    expect(computeTrajectory(td).outcome_effort.cost_per_accepted_usd).toBeNull();
  });
});
