// v8.1 Story 6 (T3-prep): LOKI_LEGACY_BASH symmetric escape hatch.
// Asserts the pure decision helper that resolveProvider uses to choose the
// claude main-loop invoker. No spawn, no SDK import. The rollback is proven to
// exist NOW, before LOKI_SDK_LOOP ever flips default-on.
import { describe, expect, test } from "bun:test";
import { selectClaudeInvokerKind } from "../../src/runner/providers.ts";

describe("selectClaudeInvokerKind: default-off and rollback precedence", () => {
  test("nothing set -> legacy (byte-identical to v8 default)", () => {
    expect(selectClaudeInvokerKind({})).toBe("legacy");
  });

  test("LOKI_SDK_LOOP=1 -> sdk (opt-in)", () => {
    expect(selectClaudeInvokerKind({ LOKI_SDK_LOOP: "1" })).toBe("sdk");
  });

  test("LOKI_LEGACY_BASH=1 alone -> legacy (no-op today, loop is off)", () => {
    expect(selectClaudeInvokerKind({ LOKI_LEGACY_BASH: "1" })).toBe("legacy");
  });

  test("ROLLBACK: LOKI_LEGACY_BASH=1 wins over LOKI_SDK_LOOP=1", () => {
    // The load-bearing case: even with the loop opted on, the escape hatch forces
    // legacy. This is what makes the rollback safe when the loop later flips on.
    expect(selectClaudeInvokerKind({ LOKI_LEGACY_BASH: "1", LOKI_SDK_LOOP: "1" })).toBe("legacy");
  });

  test("permissive spellings honored (parity with truthy())", () => {
    expect(selectClaudeInvokerKind({ LOKI_SDK_LOOP: "true" })).toBe("sdk");
    expect(selectClaudeInvokerKind({ LOKI_SDK_LOOP: "on" })).toBe("sdk");
    expect(selectClaudeInvokerKind({ LOKI_LEGACY_BASH: "yes", LOKI_SDK_LOOP: "1" })).toBe("legacy");
  });

  test("falsy LOKI_LEGACY_BASH does not trigger the hatch", () => {
    expect(selectClaudeInvokerKind({ LOKI_LEGACY_BASH: "0", LOKI_SDK_LOOP: "1" })).toBe("sdk");
    expect(selectClaudeInvokerKind({ LOKI_LEGACY_BASH: "", LOKI_SDK_LOOP: "1" })).toBe("sdk");
  });
});
