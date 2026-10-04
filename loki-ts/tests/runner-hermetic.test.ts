// A3b guard: every test runner sets a hermetic HOME and LOKI_CONTROL=0, so no suite can ship fixture runs into a developer's real control.db
// (155 fixture runs leaked once: e37-*, e10-sig, e10-sg*). A runner here is a shell entry point or a bunfig.toml that has a [test] section.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/util/paths.ts";

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

test("the shell runners export LOKI_CONTROL=0 and enter the hermetic HOME", () => {
  const all = read("tests/run-all-tests.sh");
  expect(all).toMatch(/export [^\n]*LOKI_CONTROL=0/);
  expect(all).toContain("hermetic-home.sh");
  const ci = read("scripts/local-ci.sh");
  expect(ci).toMatch(/export LOKI_CONTROL="\$\{LOKI_CONTROL:-0\}"/);
  expect(ci).toContain("loki_hermetic_home_enter");
});

test("the shared bun preload defaults LOKI_CONTROL to 0 and makes HOME hermetic", () => {
  const pre = read("loki-ts/tests/preload.ts");
  expect(pre).toMatch(/process\.env\["LOKI_CONTROL"\] = "0"/);
  expect(pre).toContain("LOKI_HERMETIC_HOME");
  expect(pre).toMatch(/process\.env\["HOME"\] =/);
});

test("every bunfig.toml with a [test] section preloads the shared hermetic preload", () => {
  const configs = ["bunfig.toml", "loki-ts/bunfig.toml", "packages/control-plane/bunfig.toml"];
  for (const rel of configs) {
    if (!existsSync(join(REPO_ROOT, rel))) continue;
    const txt = read(rel);
    if (!/^\[test\]/m.test(txt)) continue;
    expect({ file: rel, preloadsShared: /preload\s*=\s*\[[^\]]*loki-ts\/tests\/preload\.ts|preload\s*=\s*\[[^\]]*\.\/tests\/preload\.ts/.test(txt) }).toEqual({ file: rel, preloadsShared: true });
  }
});
