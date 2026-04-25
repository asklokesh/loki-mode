import { describe, expect, it } from "bun:test";
import { getVersion } from "../src/version.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

describe("getVersion", () => {
  it("matches the VERSION file", () => {
    const expected = readFileSync(resolve(REPO_ROOT, "VERSION"), "utf-8").trim();
    expect(getVersion()).toBe(expected);
  });

  it("returns a non-empty string", () => {
    expect(getVersion().length).toBeGreaterThan(0);
  });

  it("matches semver-like format (major.minor.patch)", () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
