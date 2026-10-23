import { setSpawnTimeout } from "./preload.ts";
setSpawnTimeout();
// The orchestrator's magic_debate toggle must agree with the gate body about
// whether the gate is on. readToggles() decides whether the gate is INVOKED and
// recorded as enabled (quality_gates.ts:3005-3010); runMagicDebateGate's body
// short-circuits to pass unless LOKI_GATE_MAGIC_DEBATE is exactly "true"
// (quality_gates.ts:2520, opt-in default-off per the Phase 5 spec).
//
// Those two predicates were written independently and disagreed. The toggle used
// the shared flag() helper, which returns its fallback when the var is unset or
// empty and treats "1" as true -- so on unset, "" and "1" the orchestrator
// recorded magic_debate as an ENABLED gate while the gate itself self-skipped.
// A receipt then names a gate that never ran, which is the exact class of claim
// this repo's trust layer exists to prevent.
//
// Measured before the fix (toggle_now vs gate_runs):
//   unset    toggle=true   runs=false   DISAGREE
//   ""       toggle=true   runs=false   DISAGREE
//   "true"   toggle=true   runs=true    agree
//   "1"      toggle=true   runs=false   DISAGREE
//   "false"  toggle=false  runs=false   agree
//
// The assertion compares the TWO REAL PREDICATES against each other rather than
// against a hardcoded expected column, so it stays correct if either side
// legitimately moves later. It reads readToggles directly (not a local copy of
// flag()) -- a re-implemented helper would pass even if the real toggle never
// changed.
import { describe, expect, it } from "bun:test";
import { readToggles, runMagicDebateGate } from "../src/runner/quality_gates.ts";

const SKIP_DETAIL = "disabled (LOKI_GATE_MAGIC_DEBATE!=true)";

// The five values named by the acceptance criterion.
const CASES: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ['""', ""],
  ['"true"', "true"],
  ['"1"', "1"],
  ['"false"', "false"],
];

describe("magic_debate toggle agrees with the gate body", () => {
  for (const [label, value] of CASES) {
    it(`agrees when LOKI_GATE_MAGIC_DEBATE is ${label}`, async () => {
      const prev = process.env["LOKI_GATE_MAGIC_DEBATE"];
      // A stub short-circuits the gate before the opt-in check, which would
      // measure the stub instead of the predicate under test.
      const prevStub = process.env["LOKI_STUB_GATE_MAGIC_DEBATE"];
      delete process.env["LOKI_STUB_GATE_MAGIC_DEBATE"];
      if (value === undefined) delete process.env["LOKI_GATE_MAGIC_DEBATE"];
      else process.env["LOKI_GATE_MAGIC_DEBATE"] = value;
      try {
        const enabled = readToggles().magicDebate;
        // cwd is irrelevant to the opt-in branch: it returns before touching
        // the filesystem, and every later branch also passes, so the only
        // signal we read is whether the self-skip fired.
        const result = await runMagicDebateGate({ cwd: process.cwd() } as never);
        const selfSkipped = String(result.detail ?? "").includes(SKIP_DETAIL);
        expect(enabled).toBe(!selfSkipped);
      } finally {
        if (prev === undefined) delete process.env["LOKI_GATE_MAGIC_DEBATE"];
        else process.env["LOKI_GATE_MAGIC_DEBATE"] = prev;
        if (prevStub !== undefined) process.env["LOKI_STUB_GATE_MAGIC_DEBATE"] = prevStub;
      }
    });
  }

  // POSITIVE CONTROL: the assertion above is only meaningful if the gate body
  // actually distinguishes these values. Pin that "true" runs the gate and "1"
  // does not, so a body rewritten to accept everything (or nothing) fails here
  // rather than silently making the agreement test vacuous.
  it("the gate body itself still separates \"true\" from \"1\"", async () => {
    const prev = process.env["LOKI_GATE_MAGIC_DEBATE"];
    const prevStub = process.env["LOKI_STUB_GATE_MAGIC_DEBATE"];
    delete process.env["LOKI_STUB_GATE_MAGIC_DEBATE"];
    try {
      process.env["LOKI_GATE_MAGIC_DEBATE"] = "true";
      const on = await runMagicDebateGate({ cwd: process.cwd() } as never);
      expect(String(on.detail ?? "")).not.toContain(SKIP_DETAIL);

      process.env["LOKI_GATE_MAGIC_DEBATE"] = "1";
      const off = await runMagicDebateGate({ cwd: process.cwd() } as never);
      expect(String(off.detail ?? "")).toContain(SKIP_DETAIL);
    } finally {
      if (prev === undefined) delete process.env["LOKI_GATE_MAGIC_DEBATE"];
      else process.env["LOKI_GATE_MAGIC_DEBATE"] = prev;
      if (prevStub !== undefined) process.env["LOKI_STUB_GATE_MAGIC_DEBATE"] = prevStub;
    }
  });
});
