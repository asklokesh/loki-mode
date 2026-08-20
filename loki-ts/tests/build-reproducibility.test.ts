import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWithDeterministicRoot, writeDeterministicDebugId } from "../scripts/build.ts";

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

// The checkout-root instability this pipeline removes lives ENTIRELY in Bun's
// generated debugId; `sources[]` is emitted relative to the outdir, which moves
// with the package, so module identities are already root- and depth-invariant.
// A structured canonicalizer that rewrites `sources[]` is therefore not a
// repair but a regression: it destroys identities the pipeline never made
// unstable. These tests pin that boundary.

// Bun does not chain input source maps, so a URL identity cannot be driven
// through Bun.build. It CAN reach the rewrite step, which is the layer this
// repo owns and the only layer that has ever rewritten a map.
const FOREIGN_IDENTITIES = [
  "https://cdn.example.com/vendor.js",
  "webpack:///./src/y.js",
  "/absolute/outside/root/z.ts",
];

function writePair(dir: string, sources: string[]) {
  const outfile = join(dir, "bundle.js");
  mkdirSync(dir, { recursive: true });
  writeFileSync(outfile, `console.log(1);\n//# debugId=${"A".repeat(32)}\n`);
  writeFileSync(
    `${outfile}.map`,
    JSON.stringify(
      {
        version: 3,
        sources,
        sourcesContent: sources.map(() => "export const x = 1;\n"),
        mappings: "AAAA",
        debugId: "B".repeat(32),
        names: [],
      },
      null,
      2,
    ),
  );
  return outfile;
}

describe("writeDeterministicDebugId source identities", () => {
  it("preserves URL-scheme and outside-root identities verbatim", async () => {
    const dir = join(fixtureParent, "foreign-identities");
    const outfile = writePair(dir, FOREIGN_IDENTITIES);

    await writeDeterministicDebugId(outfile);

    const map = JSON.parse(readFileSync(`${outfile}.map`, "utf8"));

    // Non-vacuity: each identity must be PRESENT, asserted individually, so a
    // fixture that silently lost one cannot green-wash the invariance check.
    for (const identity of FOREIGN_IDENTITIES) {
      expect(map.sources).toContain(identity);
    }
    // ...and the array must be exactly the input, in order: no rewriting, no
    // reordering, no relativization of the absolute outside-root entry.
    expect(map.sources).toEqual(FOREIGN_IDENTITIES);
    expect(map.sourcesContent).toHaveLength(FOREIGN_IDENTITIES.length);
  });

  it("keeps the map structured JSON and rewrites only the debugId", async () => {
    const dir = join(fixtureParent, "structured-json");
    const outfile = writePair(dir, FOREIGN_IDENTITIES);
    const before = JSON.parse(readFileSync(`${outfile}.map`, "utf8"));

    await writeDeterministicDebugId(outfile);

    const raw = readFileSync(`${outfile}.map`, "utf8");
    const after = JSON.parse(raw); // throws if the rewrite corrupted the JSON
    expect(after.debugId).toMatch(/^[A-F0-9]{32}$/);
    expect(after.debugId).not.toBe(before.debugId);
    expect(readFileSync(outfile, "utf8")).toContain(`//# debugId=${after.debugId}`);

    // Every other key is untouched.
    for (const key of ["version", "sources", "sourcesContent", "mappings", "names"]) {
      expect(after[key]).toEqual(before[key]);
    }
  });
});

describe("module identities are checkout-root invariant", () => {
  it("is unchanged by checkout name AND depth, including an outside-root source", async () => {
    // The outside-root source is the case a canonicalizer would rewrite to a
    // relative path; it must survive as an escaping `../..` identity instead.
    async function buildAtDepth(...segments: string[]) {
      const checkout = join(fixtureParent, ...segments);
      const pkg = join(checkout, "pkg");
      const src = join(pkg, "src");
      const shared = join(checkout, "shared");
      mkdirSync(src, { recursive: true });
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, "dep.ts"), "export const dep = 1;\n");
      writeFileSync(
        join(src, "index.ts"),
        "import { dep } from '../../shared/dep.ts';\nexport const answer = dep + 41;\n",
      );

      const outdir = join(pkg, "dist");
      const outfile = join(outdir, "bundle.js");
      const result = await buildWithDeterministicRoot(pkg, outfile, {
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
        map: JSON.parse(readFileSync(`${outfile}.map`, "utf8")),
        bytes: readFileSync(`${outfile}.map`, "utf8"),
      };
    }

    const shallow = await buildAtDepth("shallow-co");
    const deep = await buildAtDepth("deep", "x", "y", "z", "co");

    // Non-vacuity: the outside-root identity must actually be present, or the
    // equality below would hold trivially over two maps that never had one.
    expect(shallow.map.sources).toContain("../../shared/dep.ts");
    expect(deep.map.sources).toContain("../../shared/dep.ts");

    expect(shallow.map.sources).toEqual(deep.map.sources);
    expect(shallow.bytes).toBe(deep.bytes);
  });
});
