// D82-FLAGS: each feature is on with the env var unset and off with =0.
import { afterEach, describe, expect, test } from "bun:test";
import { speedEnabled } from "../../src/features/warm.ts";
import { formatPreModelLine } from "../../src/engine10/output.ts";
import { visualEvidenceEnabled } from "../../src/features/visual_evidence.ts";
import { slackInboundEnabled } from "../../src/contrib/slack_inbound.ts";
import { contractEnabled } from "../../src/features/contract.ts";

const saved = process.env["LOKI_SPEED"];
afterEach(() => { if (saved === undefined) delete process.env["LOKI_SPEED"]; else process.env["LOKI_SPEED"] = saved; });

describe("D82 default-on flags", () => {
  test("LOKI_SPEED (D61): on when unset, off with 0", () => {
    delete process.env["LOKI_SPEED"];
    expect(speedEnabled()).toBe(true);
    const t = { span_s: 1, stages: { intake: 1 } };
    expect(formatPreModelLine(t, {})).not.toBe("");
    process.env["LOKI_SPEED"] = "0";
    expect(speedEnabled()).toBe(false);
    expect(formatPreModelLine(t, { LOKI_SPEED: "0" })).toBe("");
  });
  test("visual evidence, contract, slack inbound: on unset, off with 0", () => {
    expect(visualEvidenceEnabled({})).toBe(true);
    expect(visualEvidenceEnabled({ LOKI_VISUAL_EVIDENCE: "0" })).toBe(false);
    expect(contractEnabled({})).toBe(true);
    expect(contractEnabled({ LOKI_CONTRACT: "0" })).toBe(false);
    expect(slackInboundEnabled({})).toBe(true);
    expect(slackInboundEnabled({ LOKI_SLACK_INBOUND: "0" })).toBe(false);
  });
});
