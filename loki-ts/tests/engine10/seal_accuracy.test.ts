// Seal accuracy runner: every labelled fixture in fixtures/verify/seal_corpus.ts is scored through `main` (the `loki verify <run-id>`
// entry point), so the run-id guard, seal-drift check and run-outcome gate are all in the path, not just verifyReceipt. The fixtures
// are full run directories (real SupervisorLog events.jsonl, log_seal receipt, signed log.sealed line), so checkEventLog and
// checkLogSeal are reached. A "positive" is exit 0. False accept = exit 0 where the label says it must not be (the failure that
// matters); false reject = a genuine pass that does not exit 0. Any exit code that differs from its label fails.
//
// Sizing (target per label, first batch is 3 to 5): a fixture is a few lines of builder code and runs in milliseconds, so cost to
// build is not the limit; CI width is. With zero false accepts in n non-pass fixtures the 95% upper bound on the false-accept rate
// is about 3/n (rule of three). Ten non-pass labels at 20 each give n=200 and a bound near 1.5%; the first batch (n about 40) only
// bounds it near 7%, so it proves the mechanism and later batches grow each label toward 20 with new tamper variants.
// Caveat: the 3/n bound assumes independent, identically distributed samples. These fixtures are hand-picked and deterministic,
// so the number is a coverage statement about the named attacks, not a population estimate of the false-accept rate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/engine10/verify_cmd.ts";
import { EXIT_OF, SEAL_LABELS, sealCorpus, type SealLabel, type SealOutcome } from "./fixtures/verify/seal_corpus.ts";

const root = mkdtempSync(join(tmpdir(), "seal-accuracy-"));
const saved = { k: process.env["LOKI_RECEIPT_SIGNING_KEY"], f: process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] };
// No local key: a receipt is only ever checked against the key a fixture supplies (or none), never a developer's real key.
beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "no-such-key.pem"); });
afterAll(() => {
  for (const [name, v] of [["LOKI_RECEIPT_SIGNING_KEY", saved.k], ["LOKI_RECEIPT_SIGNING_KEY_FILE", saved.f]] as const) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
  rmSync(root, { recursive: true, force: true });
});

const OUTCOME_OF = new Map<number, SealOutcome>(Object.entries(EXIT_OF).map(([k, v]) => [v, k as SealOutcome]));
interface Row { label: SealLabel; name: string; expected: SealOutcome; exit: number; actual: string }

async function quiet(run: () => Promise<number>): Promise<number> {
  const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as never; process.stderr.write = (() => true) as never;
  try { return await run(); } finally { process.stdout.write = w; process.stderr.write = e; }
}

describe("Seal accuracy corpus", () => {
  const corpus = sealCorpus();
  test("every label has at least 3 fixtures", () => {
    for (const l of SEAL_LABELS) expect(corpus.filter((f) => f.label === l).length).toBeGreaterThanOrEqual(3);
  });
  test("verdicts through loki verify match labels, no false accepts", async () => {
    const rows: Row[] = [];
    for (const f of corpus) {
      const { runId, pubkey } = f.build(root);
      const exit = await quiet(() => main([runId], { runsRoot: join(root, "runs"), ...(pubkey ? { pubkey } : {}) }));
      rows.push({ label: f.label, name: f.name, expected: f.expected, exit, actual: OUTCOME_OF.get(exit) ?? `exit ${exit}` });
    }
    const lines = ["label | n | false_accept | false_reject | mismatch"];
    for (const l of SEAL_LABELS) {
      const rs = rows.filter((r) => r.label === l);
      const fa = rs.filter((r) => r.exit === 0 && r.expected !== "VERIFIED").length;
      const fr = rs.filter((r) => r.expected === "VERIFIED" && r.exit !== 0).length;
      lines.push(`${l} | ${rs.length} | ${fa} | ${fr} | ${rs.filter((r) => r.exit !== EXIT_OF[r.expected]).length}`);
    }
    console.log(lines.join("\n"));
    expect(rows.filter((r) => r.exit === 0 && r.expected !== "VERIFIED").map((r) => `${r.label}/${r.name}`)).toEqual([]);
    expect(rows.filter((r) => r.exit !== EXIT_OF[r.expected]).map((r) => `${r.label}/${r.name}: want ${r.expected} got ${r.actual}`)).toEqual([]);
  });
});
