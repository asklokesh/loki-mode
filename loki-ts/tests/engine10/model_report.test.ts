// E-50 (docs/v10/BOARD.md, found by E-14): "model 'default', 1k tokens shown
// for 372k used". Fixture replay of a recorded result-cost file (the shape a
// real SDK session writes via runner/sdk_stream_parser.ts writeResultCost,
// plus the model field a provider result reports).
//
// Two contracts:
//  1. The efficiency record's (and, transitively, the receipt's) model field
//     must equal the provider-reported model from the recorded file, never
//     the caller's guess (session.ts resolveModel()'s "sonnet" placeholder)
//     and never the literal "default".
//  2. The token count that feeds the 5-line summary's Cost line must include
//     every token field the provider reported -- cache read and cache
//     creation tokens included, not just input/output.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { fold, makeEvent } from "../../src/engine10/events.ts";
import type { SessionRunOptions } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "fixtures", "model-report");
const STUB = join(FIX, "stub-session.sh");
const RECORDED_PATH = join(FIX, "result-cost-recorded.json");
const RECORDED = JSON.parse(readFileSync(RECORDED_PATH, "utf8")) as {
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  model: string;
};

function baseOpts(cwd: string, overrides: Partial<SessionRunOptions> = {}): SessionRunOptions {
  return {
    stage: "implement",
    brief: "test brief",
    tier: "development",
    iterationId: "1",
    limitS: 10,
    signal: new AbortController().signal,
    cwd,
    ...overrides,
  };
}

describe("engine10 model_report (E-50)", () => {
  test("efficiency record model equals the provider-reported model, never the caller's guess or 'default'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-model-report-"));
    process.env["MODEL_REPORT_FIXTURE"] = RECORDED_PATH;
    try {
      // The caller (session.ts's own default, mirroring resolveModel()'s
      // fallback) guesses "sonnet" -- deliberately NOT the recorded model, so
      // a pass here proves the provider-reported model wins, not the guess.
      const runner = createSessionRunner({
        provider: "claude",
        model: "sonnet",
        childCommand: ["bash", [STUB]],
        lokiRoot: join(dir, ".loki"),
      });
      const result = await runner.run(baseOpts(dir));
      expect(result.exit).toBe(0);

      const effDir = join(dir, ".loki", "metrics", "efficiency");
      expect(existsSync(effDir)).toBe(true);
      const files = readdirSync(effDir).filter((f) => /^iteration-\d+\.json$/.test(f));
      expect(files.length).toBe(1);
      const eff = JSON.parse(readFileSync(join(effDir, files[0]!), "utf8")) as { model: string };

      // Contract: the efficiency record's model field must equal the
      // provider-reported model recorded in the result-cost file.
      expect(eff.model).toBe(RECORDED.model);
      expect(eff.model).not.toBe("default");
      expect(eff.model).not.toBe("sonnet");
    } finally {
      delete process.env["MODEL_REPORT_FIXTURE"];
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("the summary token count includes cache read and creation tokens, not just input/output", () => {
    // Mirrors exactly what session.ts's recordCost() emits (session.ts:
    // cfg.emit?.("cost", stage, { session_id, usd, input_tokens, output_tokens,
    // cache_read_tokens, cache_creation_tokens, source })), fed from the same
    // recorded fixture a real SDK session would have produced.
    const events = [
      makeEvent("run-1", 0, "run.started", null, {}),
      makeEvent("run-1", 1, "cost", "implement", {
        session_id: "1",
        usd: RECORDED.total_cost_usd,
        input_tokens: RECORDED.input_tokens,
        output_tokens: RECORDED.output_tokens,
        cache_read_tokens: RECORDED.cache_read_tokens,
        cache_creation_tokens: RECORDED.cache_creation_tokens,
        source: "test",
      }),
    ];
    const folded = fold(events);

    // Folded.cost only declares usd/inputTokens/outputTokens today; read the
    // cache fields defensively (never asserting a type the declared shape
    // does not have) so this stays tsc-clean whether or not they exist yet.
    const foldedCost = folded.cost as unknown as Record<string, number | undefined>;
    const cacheRead = foldedCost["cacheReadTokens"] ?? 0;
    const cacheCreation = foldedCost["cacheCreationTokens"] ?? 0;

    const summaryTokens = folded.cost.inputTokens + folded.cost.outputTokens + cacheRead + cacheCreation;
    const providerTotal =
      RECORDED.input_tokens + RECORDED.output_tokens + RECORDED.cache_read_tokens + RECORDED.cache_creation_tokens;

    // Contract: the token count feeding the 5-line summary's Cost line must
    // equal every token field the provider reported, cache included -- this
    // is the exact "1k tokens shown for 372k used" bug E-14 found.
    expect(summaryTokens).toBe(providerTotal);
  });
});
