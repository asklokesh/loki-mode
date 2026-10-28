// Seal accuracy runner: every labelled fixture in fixtures/verify/seal_corpus.ts goes through the real offline verifier
// (verifyReceipt) and is scored. A "positive" is verdict VERIFIED. False accept = VERIFIED where the label says it must not be
// (the failure that matters); false reject = a genuine pass that is not VERIFIED. Any verdict that differs from its label fails.
//
// Sizing (target per label, first batch is 4): a fixture is a few lines of builder code and runs in milliseconds, so cost to
// build is not the limit; CI width is. With zero false accepts in n non-pass fixtures the 95% upper bound on the false-accept
// rate is about 3/n (rule of three). Five non-pass labels at 20 each give n=100 and a bound near 3%; the first batch (n=20)
// only bounds it near 15%, so it proves the mechanism and later batches grow each label toward 20 with new tamper variants.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { SEAL_LABELS, sealCorpus, type SealLabel, type SealVerdict } from "./fixtures/verify/seal_corpus.ts";

const root = mkdtempSync(join(tmpdir(), "seal-accuracy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Row { label: SealLabel; name: string; expected: SealVerdict; actual: SealVerdict; reasons: string[] }

describe("Seal accuracy corpus", () => {
  const corpus = sealCorpus();
  test("every label has at least 3 fixtures", () => {
    for (const l of SEAL_LABELS) expect(corpus.filter((f) => f.label === l).length).toBeGreaterThanOrEqual(3);
  });
  test("verifier verdicts match labels, no false accepts", async () => {
    const rows: Row[] = [];
    for (const [i, f] of corpus.entries()) {
      const { path, pubkey } = f.build(join(root, String(i)));
      const r = await verifyReceipt(path, pubkey ? { pubkey } : {});
      rows.push({ label: f.label, name: f.name, expected: f.expected, actual: r.verdict, reasons: r.reasons });
    }
    const lines = ["label | n | false_accept | false_reject | mismatch"];
    for (const l of SEAL_LABELS) {
      const rs = rows.filter((r) => r.label === l);
      const fa = rs.filter((r) => r.actual === "VERIFIED" && r.expected !== "VERIFIED").length;
      const fr = rs.filter((r) => r.expected === "VERIFIED" && r.actual !== "VERIFIED").length;
      lines.push(`${l} | ${rs.length} | ${fa} | ${fr} | ${rs.filter((r) => r.actual !== r.expected).length}`);
    }
    console.log(lines.join("\n"));
    expect(rows.filter((r) => r.actual === "VERIFIED" && r.expected !== "VERIFIED").map((r) => `${r.label}/${r.name}`)).toEqual([]);
    expect(rows.filter((r) => r.actual !== r.expected).map((r) => `${r.label}/${r.name}: want ${r.expected} got ${r.actual} (${r.reasons.join("; ")})`)).toEqual([]);
  });
});
