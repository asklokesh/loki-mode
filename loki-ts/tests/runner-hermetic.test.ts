// A3b guard: every test runner sets a hermetic HOME and LOKI_CONTROL=0, so no suite can ship fixture runs into a developer's real control.db
// (155 fixture runs leaked once: e37-*, e10-sig, e10-sg*). A runner here is a shell entry point or a bunfig.toml that has a [test] section.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/util/paths.ts";
import { reapStaleTestDirs, setLoadAwareTimeout } from "./preload.ts";

setLoadAwareTimeout(30_000);

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

// PG-64: a stopped or killed bun test must not leave loki-test-home-* / loki-test-key-* behind.
test("the preload reaper removes only marked, dead-owner, aged dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "loki-pg64-reap-"));
  try {
    const mk = (name: string, marker: string | null, ageMs: number): string => {
      const dir = join(root, name);
      mkdirSync(dir);
      if (marker !== null) {
        const m = join(dir, ".loki-test-owner");
        writeFileSync(m, marker);
        const t = new Date(Date.now() - ageMs);
        utimesSync(m, t, t);
      }
      return dir;
    };
    const deadPid = 2 ** 22 + 12345;
    const stale = mk("loki-test-home-stale", `${deadPid}\n`, 3_600_000);
    const keyStale = mk("loki-test-key-stale", `${deadPid}\n`, 3_600_000);
    const young = mk("loki-test-home-young", `${deadPid}\n`, 1_000);
    const alive = mk("loki-test-home-alive", `${process.pid}\n`, 3_600_000);
    const unmarked = mk("loki-test-home-unmarked", null, 0);
    const garbage = mk("loki-test-home-garbage", "not-a-pid", 3_600_000);
    const other = mk("loki-other-dir", `${deadPid}\n`, 3_600_000);
    const reaped = reapStaleTestDirs(root).sort();
    expect(reaped).toEqual([keyStale, stale].sort());
    for (const keep of [young, alive, unmarked, garbage, other]) expect(existsSync(keep)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bun test stopped by SIGTERM leaves no loki-test-home or loki-test-key dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "loki-pg64-term-"));
  try {
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const file = join(root, "hang.test.ts");
    writeFileSync(file, `import { test } from "bun:test";\ntest("hang", async () => { await new Promise((r) => setTimeout(r, 60000)); }, 120000);\n`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "LOKI_HERMETIC_HOME" && k !== "LOKI_RECEIPT_SIGNING_KEY_FILE") env[k] = v;
    env["HOME"] = env["LOKI_REAL_HOME"] ?? env["HOME"] ?? "";
    env["TMPDIR"] = tmp;
    const child = spawn(process.execPath, ["test", file], { cwd: join(REPO_ROOT, "loki-ts"), env, stdio: "ignore" });
    const exited = new Promise<void>((res) => child.on("exit", () => res()));
    const deadline = Date.now() + 20_000;
    while (readdirSync(tmp).filter((n) => n.startsWith("loki-test-")).length < 2 && Date.now() < deadline) await Bun.sleep(50);
    expect(readdirSync(tmp).filter((n) => n.startsWith("loki-test-")).length).toBeGreaterThanOrEqual(2);
    child.kill("SIGTERM");
    await exited;
    expect(readdirSync(tmp).filter((n) => n.startsWith("loki-test-"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
