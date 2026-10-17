// loki-ts/tests/util/yaml_key.test.ts -- S1 wall checks for the two-level yaml key reader.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lokiYamlTexts, yamlKey } from "../../src/util/yaml_key.ts";

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
  test("flow style map is read", () => {
    expect(yamlKey("budgets: { per_run: 5, run_cap_s: 900 }\n", "budgets", "per_run")).toBe("5");
    expect(yamlKey("budgets: {per_run: 5, run_cap_s: '900'} # c\n", "budgets", "run_cap_s")).toBe("900");
    expect(yamlKey("budgets: { per_run_x: 5 }\n", "budgets", "per_run")).toBeNull();
    expect(yamlKey("budgets: { note: 'a,per_run: 9', per_run: 5 }\n", "budgets", "per_run")).toBe("5");
    expect(yamlKey("budgets: { }\n", "budgets", "per_run")).toBeNull();
  });
  test("a key that merely shares a prefix does not match", () => {
    expect(yamlKey("budgets:\n  run_cap_s_extra: 5\n", "budgets", "run_cap_s")).toBeNull();
  });
});

describe("lokiYamlTexts", () => {
  const mk = (files: Record<string, string>): string => {
    const d = mkdtempSync(join(tmpdir(), "yamltexts-"));
    for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
    return d;
  };
  test("missing files give an empty list", () => {
    const d = mk({});
    try { expect(lokiYamlTexts(d)).toEqual([]); } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("loki.yml is the fallback", () => {
    const d = mk({ "loki.yml": "a: 1\n" });
    try { expect(lokiYamlTexts(d)).toEqual(["a: 1\n"]); } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("both present: loki.yaml first, then loki.yml; yamlOnly skips loki.yml", () => {
    const d = mk({ "loki.yaml": "y\n", "loki.yml": "z\n" });
    try {
      expect(lokiYamlTexts(d)).toEqual(["y\n", "z\n"]);
      expect(lokiYamlTexts(d, { yamlOnly: true })).toEqual(["y\n"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("an unreadable entry (a directory named loki.yaml) is skipped, not thrown", () => {
    const d = mk({ "loki.yml": "z\n" });
    mkdirSync(join(d, "loki.yaml"));
    try { expect(lokiYamlTexts(d)).toEqual(["z\n"]); } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
