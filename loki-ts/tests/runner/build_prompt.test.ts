// Tests for build_prompt.ts semantic-findings injection (P1-3 parity).
//
// Problem closed here (writer-no-reader anti-pattern): the Bun route's
// runSemanticTests (quality_gates.ts) WRITES <lokiDir>/quality/
// semantic-findings.txt, but build_prompt.ts did not read it, so the findings
// were dormant. The bash route reads its semantic-findings.txt in
// build_prompt and injects it into the next iteration's prompt
// (run.sh:12338-12351, INDEPENDENT of gate-failures.txt). These tests pin the
// Bun consumer to that exact bash behavior, including the discriminating case
// a nested (incorrect) implementation would silently fail: gate-failures.txt
// ABSENT + semantic-findings.txt present -> the semantic block still appears.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _internals } from "../../src/runner/build_prompt.ts";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(resolve(tmpdir(), "loki-bp-sem-test-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function mkQuality(): void {
  mkdirSync(resolve(workDir, ".loki", "quality"), { recursive: true });
}

describe("buildGateFailureContext -- semantic-findings injection (P1-3 parity)", () => {
  it("injects nothing when neither gate-failures.txt nor semantic-findings.txt exist", async () => {
    expect(await _internals.buildGateFailureContext(workDir)).toBe("");
  });

  it("surfaces semantic findings even when gate-failures.txt is absent", async () => {
    mkQuality();
    writeFileSync(
      resolve(workDir, ".loki/quality/semantic-findings.txt"),
      "# Semantic test-authenticity findings (CRITICAL/HIGH block this completion)\n" +
        "[HIGH] tests/foo.test.ts:42 assertion echoes a literal back\n",
    );
    const out = await _internals.buildGateFailureContext(workDir);
    // No gate-failures.txt -> no gate-failure prefix, but the semantic block
    // still appears. This is the case bash went out of its way to handle: the
    // completion-promise arm writes findings with NO gate token, so nesting
    // this under the gate-failures guard would silently drop it.
    expect(out).not.toContain("QUALITY GATE FAILURES");
    expect(out).toContain(
      "SEMANTIC TEST-AUTHENTICITY FINDINGS (fix the fake tests; an assertion must verify a value that flows through the code under test, not echo a literal back): ",
    );
    expect(out).toContain("[HIGH] tests/foo.test.ts:42 assertion echoes a literal back");
    // The header line has no severity token and must be dropped (same as bash grep).
    expect(out).not.toContain("# Semantic test-authenticity findings");
    // bash prepends a literal leading space before SEMANTIC; with no gate block
    // the whole string starts with it (byte-exact parity).
    expect(out.startsWith(" SEMANTIC TEST-AUTHENTICITY FINDINGS")).toBe(true);
  });

  it("appends semantic findings after the gate-failure block when both present", async () => {
    mkQuality();
    writeFileSync(resolve(workDir, ".loki/quality/gate-failures.txt"), "ERR-1: TypeError\n");
    writeFileSync(
      resolve(workDir, ".loki/quality/semantic-findings.txt"),
      "[MEDIUM] tests/bar.test.ts:7 advisory finding\n",
    );
    const out = await _internals.buildGateFailureContext(workDir);
    const gateIdx = out.indexOf("QUALITY GATE FAILURES");
    const fixIdx = out.indexOf("FIX THESE ISSUES BEFORE PROCEEDING WITH NEW WORK.");
    const semIdx = out.indexOf("SEMANTIC TEST-AUTHENTICITY FINDINGS");
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(fixIdx).toBeGreaterThan(gateIdx);
    // Semantic block comes AFTER the gate-failure "FIX THESE ISSUES" line.
    expect(semIdx).toBeGreaterThan(fixIdx);
    expect(out).toContain("[MEDIUM] tests/bar.test.ts:7 advisory finding");
  });

  it("injects nothing for an empty / non-tagged semantic-findings.txt", async () => {
    mkQuality();
    // Only the header line, no severity-tagged lines -> grep drops it -> "".
    writeFileSync(
      resolve(workDir, ".loki/quality/semantic-findings.txt"),
      "# Semantic test-authenticity findings (none)\n",
    );
    expect(await _internals.buildGateFailureContext(workDir)).toBe("");
  });

  it("caps surfaced semantic findings at 20 lines (bash head -20)", async () => {
    mkQuality();
    const many = Array.from({ length: 30 }, (_, i) => `[LOW] f${i}.test.ts:${i} finding ${i}`).join(
      "\n",
    );
    writeFileSync(resolve(workDir, ".loki/quality/semantic-findings.txt"), `${many}\n`);
    const out = await _internals.buildGateFailureContext(workDir);
    expect(out).toContain("[LOW] f0.test.ts:0 finding 0");
    expect(out).toContain("[LOW] f19.test.ts:19 finding 19");
    expect(out).not.toContain("[LOW] f20.test.ts:20 finding 20");
  });
});

// Tests for invariant-findings injection (P1-4 parity).
//
// Problem closed here (writer-no-reader anti-pattern): the bash route's
// enforce_invariant_integrity (run.sh:8422) WRITES
// <lokiDir>/quality/invariant-findings.txt (blocking + advisory), but NO
// prompt-builder read it on either route -- run.sh only logs the path
// (run.sh:15565), and the Bun runInvariants deliberately does not persist the
// file yet, naming a build_prompt.ts reader as the prerequisite follow-up
// (quality_gates.ts:786-794). These tests pin that Bun reader: invariant
// findings are surfaced INDEPENDENTLY of gate-failures.txt (the discriminating
// case a nested impl would silently fail), header-only/empty -> "", head -20 cap.
describe("buildGateFailureContext -- invariant-findings injection (P1-4 parity)", () => {
  it("surfaces invariant findings even when gate-failures.txt is absent", async () => {
    mkQuality();
    writeFileSync(
      resolve(workDir, ".loki/quality/invariant-findings.txt"),
      "# Invariant findings (CRITICAL/HIGH block this completion)\n" +
        "[HIGH] src/reverse.ts:12 reverse(reverse(x)) != x\n",
    );
    const out = await _internals.buildGateFailureContext(workDir);
    // No gate-failures.txt -> no gate-failure prefix, but the invariant block
    // still appears (the writer-no-reader case this closes).
    expect(out).not.toContain("QUALITY GATE FAILURES");
    expect(out).toContain(
      "INVARIANT VIOLATION FINDINGS (fix the violated invariants; a property/metamorphic invariant that the code under test must always uphold is currently broken): ",
    );
    expect(out).toContain("[HIGH] src/reverse.ts:12 reverse(reverse(x)) != x");
    // The header line has no severity token and must be dropped (same as the
    // bash grep filter the writer uses).
    expect(out).not.toContain("# Invariant findings");
    // Leading space before the header so it starts the string when no gate block.
    expect(out.startsWith(" INVARIANT VIOLATION FINDINGS")).toBe(true);
  });

  it("appends invariant findings after the gate-failure block when both present", async () => {
    mkQuality();
    writeFileSync(resolve(workDir, ".loki/quality/gate-failures.txt"), "ERR-1: TypeError\n");
    writeFileSync(
      resolve(workDir, ".loki/quality/invariant-findings.txt"),
      "# Invariant advisory findings (MED/LOW, non-blocking)\n" +
        "[MEDIUM] src/sort.ts:5 sort idempotence advisory\n",
    );
    const out = await _internals.buildGateFailureContext(workDir);
    const fixIdx = out.indexOf("FIX THESE ISSUES BEFORE PROCEEDING WITH NEW WORK.");
    const invIdx = out.indexOf("INVARIANT VIOLATION FINDINGS");
    expect(fixIdx).toBeGreaterThanOrEqual(0);
    // Invariant block comes AFTER the gate-failure "FIX THESE ISSUES" line.
    expect(invIdx).toBeGreaterThan(fixIdx);
    expect(out).toContain("[MEDIUM] src/sort.ts:5 sort idempotence advisory");
    // Advisory-write header (no severity token) is dropped just like the
    // blocking-write header.
    expect(out).not.toContain("# Invariant advisory findings");
  });

  it("injects nothing for an empty / non-tagged invariant-findings.txt", async () => {
    mkQuality();
    writeFileSync(
      resolve(workDir, ".loki/quality/invariant-findings.txt"),
      "# Invariant findings (none)\n",
    );
    expect(await _internals.buildGateFailureContext(workDir)).toBe("");
  });

  it("injects nothing when invariant-findings.txt is absent", async () => {
    mkQuality();
    expect(await _internals.buildGateFailureContext(workDir)).toBe("");
  });

  it("caps surfaced invariant findings at 20 lines (bash head -20 parity)", async () => {
    mkQuality();
    const many = Array.from({ length: 30 }, (_, i) => `[LOW] inv${i}.ts:${i} violation ${i}`).join(
      "\n",
    );
    writeFileSync(resolve(workDir, ".loki/quality/invariant-findings.txt"), `${many}\n`);
    const out = await _internals.buildGateFailureContext(workDir);
    expect(out).toContain("[LOW] inv0.ts:0 violation 0");
    expect(out).toContain("[LOW] inv19.ts:19 violation 19");
    expect(out).not.toContain("[LOW] inv20.ts:20 violation 20");
  });
});
