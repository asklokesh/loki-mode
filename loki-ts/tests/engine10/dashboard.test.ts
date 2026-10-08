// E-24: dashboard over SSE (docs/v10/ENGINE.md section 12).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatPanels,
  getCliVersion,
  looksLikeDashboardCommand,
  startServer,
  startServerReplacingOlder,
  summarizeRun,
  type DashboardServer,
} from "../../src/runner/engine10_dashboard.ts";
import { getVersion } from "../../src/version.ts";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "e10-dash-"));
}

function writeRun(repoDir: string, runId: string, lines: Record<string, unknown>[]): void {
  const dir = join(repoDir, ".loki", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const ev = (seq: number, type: string, stage: string | null, data: Record<string, unknown>) => ({
  v: 1, seq, ts: `2026-09-27T00:00:${String(seq).padStart(2, "0")}Z`, run: "r1", type, stage, data,
});

let repoDir: string;
let server: DashboardServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

describe("summarizeRun / formatPanels", () => {
  test("an empty run: verdict, PR and NOT PROVEN panels are absent; cost and time read not measured", () => {
    repoDir = mkRepo();
    writeRun(repoDir, "r1", [ev(0, "run.started", null, {})]);
    const s = summarizeRun(repoDir, "r1");
    expect(s.verdict).toBeNull();
    expect(s.pr).toBeNull();
    expect(s.notProven).toBeNull();
    expect(s.costUsd).toBeNull();
    const panels = formatPanels(s);
    expect(panels.find((p) => p.label === "Verdict")).toBeUndefined();
    expect(panels.find((p) => p.label === "PR")).toBeUndefined();
    expect(panels.find((p) => p.label === "NOT PROVEN")).toBeUndefined();
    expect(panels.find((p) => p.label === "Cost")).toEqual({ label: "Cost", value: "not measured" });
    expect(panels.find((p) => p.label === "Time")).toEqual({ label: "Time", value: "not measured" });
  });

  test("a completed run: every panel is present with real values, none rendered as 0", () => {
    repoDir = mkRepo();
    writeRun(repoDir, "r1", [
      ev(0, "run.started", null, {}),
      ev(1, "receipt.sealed", "seal", { not_proven: ["app boot"] }),
      ev(2, "pr.opened", "pr", { url: "https://github.com/o/r/pull/9", draft: false }),
      ev(3, "cost", null, { session_id: "s1", usd: 0.42 }),
      ev(4, "run.completed", null, { verdict: "VERIFIED" }),
    ]);
    const s = summarizeRun(repoDir, "r1");
    expect(s.verdict).toBe("VERIFIED");
    expect(s.pr).toEqual({ url: "https://github.com/o/r/pull/9", draft: false });
    expect(s.notProven).toEqual(["app boot"]);
    expect(s.costUsd).toBe(0.42);
    expect(s.wallS).toBe(4);
    const panels = formatPanels(s);
    expect(panels).toEqual([
      { label: "Verdict", value: "VERIFIED" },
      { label: "PR", value: "https://github.com/o/r/pull/9" },
      { label: "NOT PROVEN", value: "app boot" },
      { label: "Cost", value: "$0.42" },
      { label: "Time", value: "4s" },
    ]);
  });

  // E-69 rework: dashboard's Cost panel had only the $X.XX and "not measured" branches;
  // a run with one priced session and one unpriced one fell straight to "not measured",
  // losing the "partial: $X for N of M" detail output.ts already shows for the same case.
  test("a partially priced run: Cost panel shows partial: $X for N of M sessions", () => {
    repoDir = mkRepo();
    writeRun(repoDir, "r1", [
      ev(0, "run.started", null, {}),
      ev(1, "cost", null, { session_id: "s1", usd: 0.2 }),
      ev(2, "cost", null, { session_id: "s2" }), // no dollar figure: unpriced
    ]);
    const s = summarizeRun(repoDir, "r1");
    expect(s.costUsd).toBeNull();
    expect(formatPanels(s).find((p) => p.label === "Cost")).toEqual({
      label: "Cost", value: "partial: $0.20 for 1 of 2 sessions",
    });
  });

  test("a tampered run: Cost panel reads not measured, never a partial dollar figure", () => {
    repoDir = mkRepo();
    writeRun(repoDir, "r1", [
      ev(0, "run.started", null, {}),
      ev(1, "cost", null, { session_id: "s1", usd: 0.2 }),
      ev(2, "tamper.detected", null, { expected_sha256: "a", actual_sha256: "b" }),
    ]);
    const s = summarizeRun(repoDir, "r1");
    expect(s.costUsd).toBeNull();
    expect(formatPanels(s).find((p) => p.label === "Cost")).toEqual({ label: "Cost", value: "not measured" });
  });
});

describe("startServer", () => {
  test("binds 127.0.0.1 only", () => {
    repoDir = mkRepo();
    server = startServer(repoDir, 0);
    expect(server.hostname).toBe("127.0.0.1");
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("GET / serves the page; GET /api/runs lists folded runs", async () => {
    repoDir = mkRepo();
    writeRun(repoDir, "r1", [ev(0, "run.started", null, {}), ev(1, "run.completed", null, { verdict: "PARTIAL" })]);
    server = startServer(repoDir, 0);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Loki 10 dashboard</title>");
    const runs = (await (await fetch(`${server.url}api/runs`)).json()) as { runId: string; verdict: string }[];
    expect(runs).toEqual([expect.objectContaining({ runId: "r1", verdict: "PARTIAL" })]);
  });

  test("SSE replays existing events then streams a new one within 2s", async () => {
    repoDir = mkRepo();
    writeRun(repoDir, "r1", [ev(0, "run.started", null, {})]);
    server = startServer(repoDir, 0);
    const res = await fetch(`${server.url}api/runs/r1/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    async function readChunk(): Promise<string> {
      const { value } = await reader.read();
      return decoder.decode(value);
    }

    const replayed = await readChunk();
    expect(replayed).toContain('"type":"run.started"');

    // Append a new event after the initial read, then require it arrives quickly.
    writeFileSync(join(repoDir, ".loki", "runs", "r1", "events.jsonl"), JSON.stringify(ev(0, "run.started", null, {})) + "\n" + JSON.stringify(ev(1, "run.completed", null, { verdict: "VERIFIED" })) + "\n");
    const deadline = Date.now() + 2000;
    let streamed = "";
    while (Date.now() < deadline && !streamed.includes("run.completed")) {
      streamed += await readChunk();
    }
    expect(streamed).toContain('"type":"run.completed"');
    reader.cancel();
  });
});

describe("E-70: dashboard version + port replacement", () => {
  const prevCliVersion = process.env["LOKI_CLI_VERSION"];
  afterEach(() => {
    if (prevCliVersion === undefined) delete process.env["LOKI_CLI_VERSION"];
    else process.env["LOKI_CLI_VERSION"] = prevCliVersion;
  });

  test("GET /version reports the running code's version; the page wires up the warning", async () => {
    delete process.env["LOKI_CLI_VERSION"];
    repoDir = mkRepo();
    server = startServer(repoDir, 0);
    const v = (await (await fetch(`${server.url}version`)).json()) as {
      dashboard: string;
      version: string;
      cliVersion: string | null;
      pid: number;
    };
    expect(v.dashboard).toBe("loki-v10");
    expect(v.version).toBe(getVersion());
    expect(v.cliVersion).toBeNull();
    expect(v.pid).toBe(process.pid);
    expect(getCliVersion()).toBeNull();

    const html = await (await fetch(server.url)).text();
    expect(html).toContain('id="version"');
    expect(html).toContain('id="version-warn"');
    expect(html).toContain("/version");
  });

  test("a different LOKI_CLI_VERSION is reported as a mismatch against the running version", async () => {
    process.env["LOKI_CLI_VERSION"] = "0.0.1-not-the-running-build";
    repoDir = mkRepo();
    server = startServer(repoDir, 0);
    const v = (await (await fetch(`${server.url}version`)).json()) as { version: string; cliVersion: string | null };
    expect(getCliVersion()).toBe("0.0.1-not-the-running-build");
    expect(v.cliVersion).toBe("0.0.1-not-the-running-build");
    expect(v.cliVersion).not.toBe(v.version);
  });

  test("looksLikeDashboardCommand: anchored on the entry, not a bare name", () => {
    expect(looksLikeDashboardCommand("python3 -m dashboard.server")).toBe(true);
    expect(looksLikeDashboardCommand("/usr/bin/python -m dashboard.server --port 9")).toBe(true);
    expect(looksLikeDashboardCommand("bun /repo/loki-ts/src/cli.ts engine10 dashboard")).toBe(true);
    expect(looksLikeDashboardCommand("bun /repo/loki-ts/src/cli.ts engine10 status")).toBe(false);
    expect(looksLikeDashboardCommand("python3 -c \"print('dashboard.server')\"")).toBe(false);
    expect(looksLikeDashboardCommand("node other-thing --note dashboard.server")).toBe(false);
  });
});

describe("E-70: startServerReplacingOlder against a real occupant process", () => {
  const temps: string[] = [];
  const procs: Bun.Subprocess[] = [];

  afterEach(async () => {
    server?.stop();
    server = null;
    for (const p of procs.splice(0)) {
      try {
        p.kill(9);
      } catch {
        // Already gone.
      }
      await p.exited;
    }
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  function fixturePort(): number {
    // A fixed, PID-derived port avoids colliding with other suites sharing the runner.
    return 53000 + (process.pid % 4000);
  }

  async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(300) });
        return true;
      } catch {
        await Bun.sleep(25);
      }
    }
    return false;
  }

  test("an older v10 dashboard on the port is stopped and the port is reclaimed", async () => {
    const port = fixturePort();
    const dir = mkdtempSync(join(tmpdir(), "e10-dash-fixture-"));
    temps.push(dir);
    const script = join(dir, "fake-old-dashboard.ts");
    // A standalone process, its own real pid: reports itself as a v10
    // dashboard at an older version, exactly what an occupant would say.
    writeFileSync(
      script,
      [
        `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch(req) {`,
        `  const p = new URL(req.url).pathname;`,
        `  if (p === "/version") return Response.json({ dashboard: "loki-v10", version: "0.0.1-old", pid: process.pid });`,
        `  return new Response("old dashboard");`,
        `} });`,
      ].join("\n"),
    );
    const fake = Bun.spawn({ cmd: ["bun", script], env: process.env, stdout: "ignore", stderr: "ignore" });
    procs.push(fake);
    expect(await waitForHttp(`http://127.0.0.1:${port}/version`, 5000)).toBe(true);

    repoDir = mkRepo();
    server = await startServerReplacingOlder(repoDir, port);
    expect(server.port).toBe(port);
    const v = (await (await fetch(`${server.url}version`)).json()) as { version: string };
    expect(v.version).toBe(getVersion());
    const exitCode = await fake.exited;
    expect(exitCode).not.toBe(0); // it was signalled, not a clean exit
  }, 15_000);

  test("a non-Loki listener on the port is left running; bind fails with a clear error", async () => {
    const port = fixturePort() + 1;
    const dir = mkdtempSync(join(tmpdir(), "e10-dash-fixture-"));
    temps.push(dir);
    const script = join(dir, "stranger.ts");
    writeFileSync(
      script,
      `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("not a loki dashboard") });`,
    );
    const stranger = Bun.spawn({ cmd: ["bun", script], env: process.env, stdout: "ignore", stderr: "ignore" });
    procs.push(stranger);
    expect(await waitForHttp(`http://127.0.0.1:${port}/`, 5000)).toBe(true);

    repoDir = mkRepo();
    await expect(startServerReplacingOlder(repoDir, port)).rejects.toThrow(new RegExp(`${port}`));

    // Left alone: still answering, never signalled.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("not a loki dashboard");
  }, 15_000);
});
