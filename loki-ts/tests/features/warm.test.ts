import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWarmServer, WarmEngine, warmKey, type WarmServer } from "../../src/features/warm.ts";
import { warmRequest } from "../../src/features/warm_client.ts";

const temps: string[] = [];
const servers: WarmServer[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function fixtureRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-warm-"));
  temps.push(d);
  const g = (...a: string[]) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(d, "a.ts"), "export const a = 1;\n");
  g("add", "a.ts");
  g("commit", "-q", "-m", "init");
  return d;
}

describe("warm engine", () => {
  test("second get is a hit; a dirty edit invalidates", () => {
    const repo = fixtureRepo();
    const e = new WarmEngine();
    expect(e.get(repo).hit).toBe(false);
    expect(e.get(repo).hit).toBe(true);
    const k1 = warmKey(repo);
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    const k2 = warmKey(repo);
    expect(k2).not.toBe(k1);
    expect(e.get(repo).hit).toBe(false);
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    expect(warmKey(repo)).not.toBe(k2);
  });

  test("serves maps over a unix socket in a temp dir", async () => {
    const repo = fixtureRepo();
    const dir = mkdtempSync(join(tmpdir(), "e10-wsock-"));
    temps.push(dir);
    const path = join(dir, "engine.sock");
    servers.push(startWarmServer(path));
    await new Promise((r) => setTimeout(r, 50));
    expect((await warmRequest({ op: "ping" }, 1000, path))?.ok).toBe(true);
    const r = await warmRequest({ op: "get", repoDir: repo }, 5000, path);
    expect(r?.ok).toBe(true);
    expect(r?.repomap?.files).toContain("a.ts");
    const r2 = await warmRequest({ op: "get", repoDir: repo }, 5000, path);
    expect(r2?.hit).toBe(true);
  });
});
