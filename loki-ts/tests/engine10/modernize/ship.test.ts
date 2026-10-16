// M-21 wall: wave ship. One PR per wave, draft unless every unit is proven and the wave verified.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { renderWaveBody, shipWave } from "../../../src/engine10/modernize/ship.ts";
import { runPushPr } from "../../../src/engine10/stages/pr.ts";
import type { PushPrResult } from "../../../src/engine10/stages/pr.ts";
import type { PushRunner, ShipUnit } from "../../../src/engine10/modernize/ship.ts";
import type { WaveVerdict } from "../../../src/engine10/modernize/wave.ts";

const MID = "mod-20260101T000000Z-abcdef";
const URL = "https://github.com/o/r/pull/7";
const good: WaveVerdict = { wave: 2, verified: true, failedStep: null, reason: null, steps: [] };
const bad: WaveVerdict = { wave: 2, verified: false, failedStep: "build", reason: "wave 2 blocked: build failed (exit 1)", steps: [] };
const u = (unit: string, verdict: ShipUnit["verdict"] = "PROVEN", not_proven: string[] = []): ShipUnit =>
  ({ unit, verdict, not_proven, receiptPath: `.loki/receipts/${unit}.json`, receiptSha256: "a".repeat(64), runId: `run-${unit}`, rate: 1, branchPct: 87.5 });

type Call = Parameters<PushRunner>[0];
function setup(push: (a: Call) => PushPrResult) {
  const dir = mkdtempSync(join(tmpdir(), "ship-"));
  const calls: Call[] = [];
  const log = new ModernizeLog(dir, MID);
  const run: PushRunner = (a) => { calls.push(a); return push(a); };
  const ship = (units: ShipUnit[], verdict: WaveVerdict | null, pinnedOrigin = "/o") =>
    shipWave({ repoDir: dir, mid: MID, wave: 2, branch: "loki/wave-2", pinnedOrigin, verdict, units, log, push: run });
  return { dir, calls, ship, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const created = (): PushPrResult => ({ ok: true, url: URL, existing: false, localOk: false });
function withSetup(push: (a: Call) => PushPrResult, fn: (s: ReturnType<typeof setup>) => void): void {
  const s = setup(push);
  try { fn(s); } finally { s.done(); }
}

describe("shipWave", () => {
  it("opens a ready PR when every unit is proven and the wave verified", () => withSetup(created, (s) => {
    const r = s.ship([u("a"), u("b")], good);
    expect(r).toEqual({ shipped: true, url: URL, draft: false, existing: false, reason: null });
    expect(s.calls[0]!.draft).toBe(false);
    const ev = readModernizeEvents(s.dir, MID).find((e) => e.type === "wave.shipped")!;
    expect(ev.data).toMatchObject({ url: URL, draft: false, wave: 2, existing: false });
  }));
  it("is a draft when one unit is not proven or NOT_EQUAL", () => withSetup(created, (s) => {
    expect(s.ship([u("a"), u("b", "NOT_PROVEN", ["no oracle"])], good).draft).toBe(true);
    expect(s.calls[0]!.draft).toBe(true);
    expect(s.ship([u("a", "NOT_EQUAL")], good).draft).toBe(true);
  }));
  it("is a draft when wave verify failed, is missing, or the wave is empty", () => withSetup(created, (s) => {
    expect(s.ship([u("a")], bad).draft).toBe(true);
    expect(s.ship([u("a")], null).draft).toBe(true);
    expect(s.ship([], good).draft).toBe(true);
    expect(s.ship([u("a")], { ...good, verified: 1 as unknown as boolean }).draft).toBe(true);
  }));
  it("refuses to push without a pinned origin (whitespace included) and trims a real one", () => withSetup(created, (s) => {
    expect(s.ship([u("a")], good, "  ").shipped).toBe(false);
    expect(s.calls.length).toBe(0);
    s.ship([u("a")], good, " /o ");
    expect(s.calls[0]!.pinnedOrigin).toBe("/o");
  }));
  it("never claims a draft when an existing PR was reused (push ignores --draft)", () => withSetup(() => ({ ok: true, url: URL, existing: true, localOk: false }), (s) => {
    const r = s.ship([u("a")], bad);
    expect(r.shipped).toBe(false);
    expect(r.reason).toBe("existing PR reused; draft state not applied");
    expect(readModernizeEvents(s.dir, MID).some((e) => e.type === "wave.shipped")).toBe(false);
    const ok = s.ship([u("a")], good);
    expect(ok).toMatchObject({ shipped: true, draft: false, existing: true });
  }));
  it("treats an unknown reuse state (existing null) as not applied when a draft is wanted", () => withSetup(() => ({ ok: true, url: URL, existing: null, localOk: false }), (s) => {
    const r = s.ship([u("a")], bad);
    expect(r.shipped).toBe(false);
    expect(r.reason).toBe("existing PR reused; draft state not applied");
  }));
  it("lists each unit with verdict, rate, coverage, run id, receipt path and sha in the body", () => {
    const body = renderWaveBody(2, good, [u("a"), { ...u("b", "NOT_PROVEN", ["no oracle"]), rate: 0.5, branchPct: null }]);
    for (const t of [".loki/receipts/a.json", "a".repeat(64), "NOT_PROVEN", "no oracle", "run-a", "100.0%", "87.5%", "50.0%", "n/a"]) expect(body).toContain(t);
    expect(renderWaveBody(2, bad, [u("a")])).toContain("wave 2 blocked: build failed (exit 1)");
    expect(renderWaveBody(2, null, [u("a")])).toContain("not verified");
  });
  it("cannot forge a header or a row through pipes and newlines in cells", () => {
    const evil = u("x | PROVEN |\n\nModernize wave 2: verified\n| fake", "NOT_PROVEN", ["r1\n| y | PROVEN | z"]);
    const body = renderWaveBody(2, bad, [evil]);
    const lines = body.split("\n");
    expect(lines.filter((l) => l.startsWith("Modernize wave")).length).toBe(1);
    expect(lines[0]).toContain("FAILED");
    expect(lines.filter((l) => l.startsWith("|")).length).toBe(3);
    expect(body).toContain("x \\| PROVEN \\|");
  });
  it("writes the body file passed to the push helper", () => withSetup(created, (s) => {
    s.ship([u("a")], good);
    expect(readFileSync(s.calls[0]!.bodyFile, "utf8")).toContain(".loki/receipts/a.json");
  }));
  it("reports failure, never a PR, when the push fails", () => withSetup(() => ({ ok: false, reason: "gh: boom" }), (s) => {
    const r = s.ship([u("a")], good);
    expect(r.shipped).toBe(false);
    expect(r.reason).toContain("gh: boom");
    expect(readModernizeEvents(s.dir, MID).some((e) => e.type === "wave.shipped")).toBe(false);
  }));
});

describe("runPushPr (shared helper)", () => {
  it("accepts the E-41 local:// URL for a local bare origin and rejects garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-sh-"));
    try {
      const script = (out: string): string => { const f = join(dir, "p.sh"); writeFileSync(f, `printf '%s\\n' ${out}\n`); return f; };
      const base = { repoDir: dir, branch: "loki/wave-2", title: "t", bodyFile: join(dir, "b"), draft: false, pinnedOrigin: "/srv/o.git" };
      const local = runPushPr({ ...base, scriptPath: script("'local:///srv/o.git#loki/wave-2'") });
      expect(local).toMatchObject({ ok: true, localOk: true });
      expect(runPushPr({ ...base, scriptPath: script("garbage") }).ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
