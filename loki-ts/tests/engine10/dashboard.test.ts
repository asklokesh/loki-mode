// E-24: dashboard over SSE (docs/v10/ENGINE.md section 12).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPanels, startServer, summarizeRun, type DashboardServer } from "../../src/engine10/dashboard/server.ts";

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
