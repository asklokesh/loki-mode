import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { appProbe, stopApp } from "../../src/util/app_probe.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const fixture = (): string => { const d = mkdtempSync(join(tmpdir(), "app-probe-")); roots.push(d); return d; };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = (): Promise<string> => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(String(p))); });
});
const by = (r: Awaited<ReturnType<typeof appProbe>>, n: string) => r.checks.find((c) => c.name === n);
// A red http probe on a runner we cannot reach (macOS nightly) must carry its own evidence: print app-runner's files.
const explain = (d: string, r: Awaited<ReturnType<typeof appProbe>>): void => {
  if (by(r, "http probe")?.result === "pass") return;
  const ar = join(d, ".loki", "app-runner");
  const dump = ["detection.json", "state.json", "health.json", "app.log"].map((f) => `--- ${f}\n${existsSync(join(ar, f)) ? readFileSync(join(ar, f), "utf8").slice(-4000) : "(missing)"}`);
  console.error(`appProbe diagnostics ${JSON.stringify(r.checks)}\n${dump.join("\n")}`);
};

describe("appProbe", () => {
  it("static site: boot pass, http probe pass, nothing left on the PID", async () => {
    const d = fixture();
    writeFileSync(join(d, "index.html"), "<h1>hi</h1>");
    const r = await appProbe(d, join(d, ".loki"), { env: { LOKI_APP_PORT: await freePort() }, timeoutMs: 40_000 });
    explain(d, r);
    expect(by(r, "app boot")?.result).toBe("pass");
    expect(by(r, "http probe")?.result).toBe("pass");
    expect(r.pid).not.toBeNull();
    expect(alive(r.pid as number)).toBe(false);
    const up = await fetch(r.url as string).then(() => true, () => false);
    expect(up).toBe(false);
  }, 60_000);

  it("start command that exits 1: boot fail, probe not_run", async () => {
    const d = fixture();
    const r = await appProbe(d, join(d, ".loki"), { env: { LOKI_APP_COMMAND: "false" }, timeoutMs: 40_000 });
    expect(by(r, "app boot")?.result).toBe("fail");
    expect(by(r, "http probe")?.result).toBe("not_run");
  }, 60_000);

  it("empty repo (FC-SEAL-NA-AS-UNPROVEN): n/a, never fail, never not_run", async () => {
    const d = fixture();
    const r = await appProbe(d, join(d, ".loki"), { timeoutMs: 40_000 });
    expect(by(r, "app boot")?.result).toBe("n/a");
    expect(by(r, "http probe")?.result).toBe("n/a");
    expect(r.checks.some((c) => c.result === "fail")).toBe(false);
  }, 60_000);

  it("a Docker project whose runtime is missing is not_run (a real gap), never n/a", async () => {
    const d = fixture();
    writeFileSync(join(d, "Dockerfile"), "FROM scratch\n");
    const r = await appProbe(d, join(d, ".loki"), { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 40_000 });
    expect(by(r, "app boot")?.result).toBe("not_run");
    expect(r.checks.some((c) => c.result === "n/a")).toBe(false);
  }, 60_000);

  it("mutation: skipStop leaves the PID alive (proves the leftover-PID assertion bites)", async () => {
    const d = fixture();
    writeFileSync(join(d, "index.html"), "<h1>hi</h1>");
    const r = await appProbe(d, join(d, ".loki"), { skipStop: true, env: { LOKI_APP_PORT: await freePort() }, timeoutMs: 40_000 });
    const pid = r.pid as number;
    const left = alive(pid);
    stopApp(d);
    expect(left).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it("boot timeout still stops the recorded app PID", async () => {
    const d = fixture();
    const r = await appProbe(d, join(d, ".loki"), { env: { LOKI_APP_COMMAND: "sleep 300", LOKI_APP_PORT: await freePort() }, timeoutMs: 4_000 });
    expect(r.pid).toBeNull();
    const pf = join(d, ".loki", "app-runner", "app.pid");
    const recorded = existsSync(pf) ? readFileSync(pf, "utf8").trim() : "";
    if (/^\d+$/.test(recorded)) expect(alive(Number(recorded))).toBe(false);
    expect(existsSync(pf)).toBe(false);
  }, 60_000);

  it("functional verify writes functional-results.json when specText has endpoints", async () => {
    const d = fixture();
    writeFileSync(join(d, "index.html"), "<h1>hi</h1>");
    const r = await appProbe(d, join(d, ".loki"), { specText: "GET /index.html", env: { LOKI_APP_PORT: await freePort() }, timeoutMs: 40_000 });
    explain(d, r);
    expect(by(r, "functional verify")).toBeDefined();
    expect(existsSync(join(d, ".loki", "quality", "functional-results.json"))).toBe(true);
  }, 60_000);
});
