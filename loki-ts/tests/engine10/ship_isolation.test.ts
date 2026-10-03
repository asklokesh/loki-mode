// P0 guard: a test-mode or throwaway run must never ship to a Control Plane discovered through HOME. A sandbox HOME holds an
// instance.json pointing at a local stub; the stub must see ZERO requests (not even a /health probe) unless the run is a normal repo.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryRefusal, isThrowawayPath } from "../../../packages/control-plane/src/shipper/discover.ts";
import { startShip } from "../../src/e10ext/ship_hook.ts";
import { runSupervisor, SupervisorLog } from "../../src/engine10/supervisor.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

let hits: string[] = [];
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  hits.push(u.pathname);
  if (u.pathname === "/health") return Response.json({ service: "loki-control" });
  return Response.json({});
} });
afterAll(() => srv.stop(true));
beforeEach(() => { hits = []; });

// A checkout under the OS temp dir (for example a scratch worktree) is itself throwaway, so fall back to HOME.
const outsideTmp = (): string => (isThrowawayPath(process.cwd()) ? homedir() : process.cwd());

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "shipiso-home-"));
  roots.push(home);
  mkdirSync(join(home, ".loki", "control"), { recursive: true });
  writeFileSync(join(home, ".loki", "control", "instance.json"), JSON.stringify({ pid: process.pid, port: srv.port, url: `http://127.0.0.1:${srv.port}` }));
  return home;
}
function repoIn(base: string, origin?: string): string {
  const dir = mkdtempSync(join(base, "shipiso-repo-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "a.txt"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}
function startLog(repo: string): SupervisorLog {
  const runDir = join(repo, ".loki", "runs", "iso1");
  mkdirSync(runDir, { recursive: true });
  const log = new SupervisorLog(join(runDir, "events.jsonl"), "iso1");
  log.append("run.started", null, {});
  return log;
}
const shipped = async (repo: string): Promise<boolean> => {
  for (let i = 0; i < 15 && !existsSync(join(repo, ".loki", "runs", "iso1", "ship.json")); i++) await Bun.sleep(100);
  return existsSync(join(repo, ".loki", "runs", "iso1", "ship.json"));
};

describe("test-mode isolation", () => {
  test("runSupervisor with a minimal caller env (no LOKI_CONTROL) inherits the preload off switch: zero requests", async () => {
    expect(process.env["LOKI_CONTROL"]).toBe("0"); // tests/preload.ts
    const home = sandboxHome();
    const repo = repoIn(tmpdir(), "https://github.com/acme/widget.git");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, LOKI_CLAUDE_CLI: "/usr/bin/true" };
    await runSupervisor({ runId: "iso1", repoDir: repo, env, workerArgv: [process.execPath, "-e", "await new Promise((r) => setTimeout(r, 700))"], capS: 20 });
    await Bun.sleep(500);
    expect(hits).toEqual([]);
  }, 30000);
});

describe("discovery guard (product)", () => {
  test("a repo under the OS temp dir never auto-ships, and discovery is not even probed", async () => {
    const home = sandboxHome(), repo = repoIn(tmpdir());
    await startShip(repo, startLog(repo).path, { HOME: home });
    expect(await shipped(repo)).toBe(false);
    expect(hits).toEqual([]);
  });
  test("a repo whose origin is acme/widget never auto-ships even outside the temp dir", async () => {
    const home = sandboxHome(), repo = repoIn(outsideTmp(), "git@github.com:acme/widget.git");
    await startShip(repo, startLog(repo).path, { HOME: home });
    expect(await shipped(repo)).toBe(false);
    expect(hits).toEqual([]);
  });
  test("a normal repo outside the temp dir still ships through discovery", async () => {
    const home = sandboxHome(), repo = repoIn(outsideTmp(), "https://github.com/real-org/real-app.git");
    await startShip(repo, startLog(repo).path, { HOME: home });
    expect(await shipped(repo)).toBe(true);
    expect(hits).toContain("/health");
  });
  test("an explicit LOKI_CONTROL_URL still ships a temp repo (operator decision)", async () => {
    const home = sandboxHome(), repo = repoIn(tmpdir());
    await startShip(repo, startLog(repo).path, { HOME: home, LOKI_CONTROL_URL: `http://127.0.0.1:${srv.port}` });
    expect(await shipped(repo)).toBe(true);
  });
  test("LOKI_CONTROL_ALLOW_TMP=1 lets a sandboxed harness discover from a temp repo", async () => {
    const home = sandboxHome(), repo = repoIn(tmpdir());
    await startShip(repo, startLog(repo).path, { HOME: home, LOKI_CONTROL_ALLOW_TMP: "1" });
    expect(await shipped(repo)).toBe(true);
  });
});

describe("discoveryRefusal", () => {
  const roots2 = ["/tmp", "/private/tmp", "/var/folders"];
  test("temp roots", () => {
    expect(isThrowawayPath("/tmp/x", roots2)).toBe(true);
    expect(isThrowawayPath("/private/tmp/x/y", roots2)).toBe(true);
    expect(isThrowawayPath("/var/folders/ab/cd/T/x", roots2)).toBe(true);
    expect(isThrowawayPath("/Users/dev/code/app", roots2)).toBe(false);
    expect(isThrowawayPath("/tmpfoo/app", roots2)).toBe(false);
  });
  test("fixture origin forms", () => {
    for (const o of ["https://github.com/acme/widget.git", "git@github.com:acme/widget.git", "https://github.com/acme/widget", "ssh://git@github.com/acme/widget.git"]) {
      expect(discoveryRefusal("/Users/dev/code/app", o, {}, roots2)).not.toBeNull();
    }
    expect(discoveryRefusal("/Users/dev/code/app", "https://github.com/acme/widgets.git", {}, roots2)).toBeNull();
    expect(discoveryRefusal("/Users/dev/code/app", "https://github.com/real/widget.git", {}, roots2)).toBeNull();
    expect(discoveryRefusal("/Users/dev/code/app", null, {}, roots2)).toBeNull();
  });
});
