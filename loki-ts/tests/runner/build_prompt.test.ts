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
