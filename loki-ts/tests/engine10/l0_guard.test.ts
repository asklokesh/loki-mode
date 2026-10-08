// select: walk-all-src
// EL-W1-00: L0 static guard. No file under loki-ts/src may probe a manifest
// file name or embed a runner command unless listed in l0_guard.allowlist.
// The allowlist may only shrink: a stale entry fails the test too.
// Regenerate (shrink only, review the diff): L0_WRITE_ALLOWLIST=1 bun test tests/engine10/l0_guard.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const HERE = import.meta.dir;
const SRC = join(HERE, "..", "..", "src");
const ALLOWLIST = join(HERE, "l0_guard.allowlist");

const MANIFESTS = [
  "package.json", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml",
  "pom.xml", "build.gradle", "Gemfile", "composer.json", "requirements.txt",
];
const RUNNERS = [
  "npm test", "pytest", "go test", "cargo test", "jest", "vitest",
  "mvn test", "gradle test", "bundle exec rspec",
];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOKENS = [...MANIFESTS, ...RUNNERS];
const PATTERNS: Array<[string, RegExp]> = TOKENS.map((t) => [
  t,
  new RegExp(`(?<![A-Za-z0-9_.-])${esc(t)}(?![A-Za-z0-9_-])`),
]);

/** Returns the sorted distinct tokens found in a file's content. */
export function detect(content: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(content)).map(([t]) => t).sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function inventory(): string[] {
  const rows: string[] = [];
  for (const f of walk(SRC)) {
    const rel = relative(join(SRC, ".."), f).split(sep).join("/");
    for (const t of detect(readFileSync(f, "utf8"))) rows.push(`${rel}\t${t}`);
  }
  return rows.sort();
}

function loadAllowlist(): string[] {
  return readFileSync(ALLOWLIST, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .sort();
}

describe("L0 guard: no hardcoded repo knowledge in the harness", () => {
  test("planted probe self-check: detector goes red on probes, green on clean text", () => {
    expect(detect('const m = "package.json";')).toEqual(["package.json"]);
    expect(detect("run('pytest -q')")).toEqual(["pytest"]);
    expect(detect("exec('npm test')")).toEqual(["npm test"]);
    expect(detect("bundle exec rspec spec/")).toEqual(["bundle exec rspec"]);
    expect(detect("const x = 1; // nothing to see")).toEqual([]);
    const allowed = new Set(loadAllowlist());
    const plantedRows = detect('const m = "go.mod";').map((t) => `src/planted_probe.ts\t${t}`);
    expect(plantedRows.filter((r) => !allowed.has(r))).toEqual(["src/planted_probe.ts\tgo.mod"]);
  });

  test("no unlisted manifest probe or runner command under loki-ts/src", () => {
    if (process.env.L0_WRITE_ALLOWLIST === "1") {
      writeFileSync(ALLOWLIST, inventory().join("\n") + "\n");
    }
    const allowed = new Set(loadAllowlist());
    const unlisted = inventory().filter((r) => !allowed.has(r));
    expect(unlisted).toEqual([]);
  });

  test("every allowlist entry still matches (the list can only shrink)", () => {
    const actual = new Set(inventory());
    const stale = loadAllowlist().filter((r) => !actual.has(r));
    expect(stale).toEqual([]);
  });
});
