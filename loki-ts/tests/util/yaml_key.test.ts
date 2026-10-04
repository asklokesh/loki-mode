// loki-ts/tests/util/yaml_key.test.ts -- S1 wall checks for the two-level yaml key reader.
import { describe, expect, test } from "bun:test";
import { yamlKey } from "../../src/util/yaml_key.ts";

describe("yamlKey", () => {
  test("reads a first-child key", () => {
    expect(yamlKey("budgets:\n  run_cap_s: 1200\n  per_run: 5\n", "budgets", "run_cap_s")).toBe("1200");
    expect(yamlKey("budgets:\n  run_cap_s: 1200\n  per_run: 5\n", "budgets", "per_run")).toBe("5");
  });
  test("ignores a nested per_stage run_cap_s", () => {
    const y = "budgets:\n  per_stage:\n    run_cap_s: 99\n  per_run: 5\n";
    expect(yamlKey(y, "budgets", "run_cap_s")).toBeNull();
    expect(yamlKey(`${y}  run_cap_s: 700\n`, "budgets", "run_cap_s")).toBe("700");
  });
  test("reads CRLF", () => {
    expect(yamlKey("budgets:\r\n  run_cap_s: 1500\r\n  per_run: 3\r\n", "budgets", "run_cap_s")).toBe("1500");
    expect(yamlKey("budgets: # c\r\n\r\n  per_run: 3\r\n", "budgets", "per_run")).toBe("3");
  });
  test("stops at the next top-level key and handles the last line without a newline", () => {
    expect(yamlKey("budgets:\n  per_run: 3\nother:\n  run_cap_s: 5\n", "budgets", "run_cap_s")).toBeNull();
    expect(yamlKey("budgets:\n  run_cap_s: 42", "budgets", "run_cap_s")).toBe("42");
  });
  test("strips comments and quotes; empty value is null; absent parent is null", () => {
    expect(yamlKey("budgets:\n  # note\n  run_cap_s: '900' # why\n", "budgets", "run_cap_s")).toBe("900");
    expect(yamlKey("budgets:\n  run_cap_s:\n", "budgets", "run_cap_s")).toBeNull();
    expect(yamlKey("x: 1\n", "budgets", "run_cap_s")).toBeNull();
  });
  test("a key that merely shares a prefix does not match", () => {
    expect(yamlKey("budgets:\n  run_cap_s_extra: 5\n", "budgets", "run_cap_s")).toBeNull();
  });
});
