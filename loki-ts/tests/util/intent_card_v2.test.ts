import { describe, expect, test } from "bun:test";
import {
  applyIntent, CARD_MAX_LINES, INTENT_CARD_INSTRUCTION, INTENT_HEADER, intentCardEnabled, parseIntentCard, renderIntent,
} from "../../src/util/intent_card";

const HEAD = `${INTENT_HEADER} a search ranking tweak`;
const V1 = [HEAD, "Acceptance: ranking test passes", "Acceptance: no other file changes"];
const V1_GOLDEN = "What I think you want: a search ranking tweak\nAcceptance: ranking test passes\nAcceptance: no other file changes";

describe("intent card v2: Out of scope line", () => {
  test("parse keeps an Out of scope line inside the card", () => {
    const raw = ["step 1", HEAD, "Out of scope: the indexer", "Acceptance: a", "Acceptance: b", "step 2"].join("\n");
    const r = parseIntentCard(raw);
    expect(r.card).toEqual([HEAD, "Out of scope: the indexer", "Acceptance: a", "Acceptance: b"]);
    expect(r.rest).toBe("step 1\nstep 2");
  });
  test("Out of scope counts against CARD_MAX_LINES", () => {
    const raw = [HEAD, "Out of scope: x", "Acceptance: a", "Acceptance: b", "Acceptance: c", "Acceptance: d"].join("\n");
    const r = parseIntentCard(raw);
    expect(r.card?.length).toBe(CARD_MAX_LINES);
    expect(r.card?.[1]).toBe("Out of scope: x");
    expect(r.card?.[4]).toBe("Acceptance: c");
  });
  test("v1 card renders byte-identical to the v1 golden", () => {
    expect(renderIntent(V1)).toBe(V1_GOLDEN);
    expect(renderIntent(parseIntentCard(V1.join("\n")).card)).toBe(V1_GOLDEN);
  });
  test("instruction mentions Out of scope and still says 3 to 5 lines", () => {
    expect(INTENT_CARD_INSTRUCTION).toContain("Out of scope:");
    expect(INTENT_CARD_INSTRUCTION).toContain("3 to 5 lines");
  });
  test("an over-long Out of scope line is truncated to 200 and keeps the next Acceptance line", () => {
    const raw = [HEAD, `Out of scope: ${"x".repeat(500)}`, "Acceptance: a", "Acceptance: b"].join("\n");
    const card = parseIntentCard(raw).card as string[];
    expect(card[1]?.length).toBe(200);
    expect(card[1]?.startsWith("Out of scope: ")).toBe(true);
    expect(card[2]).toBe("Acceptance: a");
    expect(card.length).toBe(4);
  });
  test("LOKI_INTENT_CARD=0 yields no card and no Out of scope text", async () => {
    expect(intentCardEnabled({ LOKI_INTENT_CARD: "0" })).toBe(false);
    const raw = [HEAD, "Out of scope: the indexer", "Acceptance: a", "Acceptance: b"].join("\n");
    const r = await applyIntent(raw, false, "/nonexistent", () => {});
    expect(r.data).toEqual({});
    expect(JSON.stringify(r.data)).not.toContain("Out of scope");
  });
});
