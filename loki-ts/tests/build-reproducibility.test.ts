import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWithDeterministicRoot } from "../scripts/build.ts";

const fixtureParent = mkdtempSync(join(tmpdir(), "loki-build-roots-"));

afterAll(() => {
  rmSync(fixtureParent, { recursive: true, force: true });
});

async function buildFixture(name: string) {
  const root = join(fixtureParent, name);
  const src = join(root, "src");
  const outdir = join(root, "dist");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "index.ts"), "export const answer: number = 42;\n");

  const outfile = join(outdir, "bundle.js");
  const result = await buildWithDeterministicRoot(root, outfile, {
    entrypoints: [join(src, "index.ts")],
    outdir,
    naming: "bundle.js",
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "external",
    splitting: false,
  });
  expect(result.success).toBe(true);

  return {
    bundle: readFileSync(outfile, "utf8"),
    map: readFileSync(`${outfile}.map`, "utf8"),
  };
}

describe("buildWithDeterministicRoot", () => {
  it("produces byte-identical bundles and maps under different absolute roots", async () => {
    const first = await buildFixture("first-absolute-root");
    const second = await buildFixture("second-absolute-root");

    expect(first.bundle).toBe(second.bundle);
    expect(first.map).toBe(second.map);

    const debugId = JSON.parse(first.map).debugId as string;
    expect(debugId).toMatch(/^[A-F0-9]{32}$/);
    expect(first.bundle).toContain(`//# debugId=${debugId}`);
  });
});
