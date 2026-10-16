// M-21 wall: wave ship. One PR per wave, draft unless every unit is proven and the wave verified.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { renderWaveBody, shipWave } from "../../../src/engine10/modernize/ship.ts";
import type { PushRun, ShipUnit } from "../../../src/engine10/modernize/ship.ts";
import type { WaveVerdict } from "../../../src/engine10/modernize/wave.ts";

const MID = "mod-20260101T000000Z-abcdef";
const URL = "https://github.com/o/r/pull/7";
const good: WaveVerdict = { wave: 2, verified: true, failedStep: null, reason: null, steps: [] };
const bad: WaveVerdict = { wave: 2, verified: false, failedStep: "build", reason: "wave 2 blocked: build failed (exit 1)", steps: [] };
const u = (unit: string, verdict: ShipUnit["verdict"] = "PROVEN", not_proven: string[] = []): ShipUnit =>
  ({ unit, verdict, not_proven, receiptPath: `.loki/receipts/${unit}.json`, receiptSha256: "a".repeat(64) });

function setup(push: (args: string[]) => PushRun) {
  const dir = mkdtempSync(join(tmpdir(), "ship-"));
  const calls: string[][] = [];
  const log = new ModernizeLog(dir, MID);
  const run = (args: string[]): PushRun => { calls.push(args); return push(args); };
  const ship = (units: ShipUnit[], verdict: WaveVerdict | null) =>
    shipWave({ repoDir: dir, mid: MID, wave: 2, branch: "loki/wave-2", pinnedOrigin: "/o", verdict, units, log, push: run });
  return { dir, calls, ship, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const created = (): PushRun => ({ status: 0, stdout: `created\n${URL}\n`, stderr: "" });
const isDraft = (args: string[]) => args.includes("--draft");

describe("shipWave", () => {
  it("opens a ready PR when every unit is proven and the wave verified", () => {
    const s = setup(created);
    const r = s.ship([u("a"), u("b")], good);
    expect(r).toEqual({ shipped: true, url: URL, draft: false, reason: null });
    expect(isDraft(s.calls[0]!)).toBe(false);
    const ev = readModernizeEvents(s.dir, MID).find((e) => e.type === "wave.shipped")!;
    expect(ev.data).toMatchObject({ url: URL, draft: false, wave: 2 });
    s.done();
  });
  it("is a draft when one unit is not proven", () => {
    const s = setup(created);
    const r = s.ship([u("a"), u("b", "NOT_PROVEN", ["no oracle"])], good);
    expect(r.draft).toBe(true);
    expect(isDraft(s.calls[0]!)).toBe(true);
    s.done();
  });
  it("is a draft when a unit is NOT_EQUAL", () => {
    const s = setup(created);
    expect(s.ship([u("a", "NOT_EQUAL")], good).draft).toBe(true);
    s.done();
  });
  it("is a draft when wave verify failed", () => {
    const s = setup(created);
    expect(s.ship([u("a")], bad).draft).toBe(true);
    s.done();
  });
  it("is a draft when verification is missing or the wave has no units", () => {
    const s = setup(created);
    expect(s.ship([u("a")], null).draft).toBe(true);
    expect(s.ship([], good).draft).toBe(true);
    s.done();
  });
  it("refuses to push without a pinned origin", () => {
    const s = setup(created);
    const r = shipWave({ repoDir: s.dir, mid: MID, wave: 2, branch: "b", pinnedOrigin: "", verdict: good, units: [u("a")], push: () => created() });
    expect(r.shipped).toBe(false);
    expect(s.calls.length).toBe(0);
    s.done();
  });
  it("lists each unit with verdict, receipt path, sha and reasons in the body", () => {
    const body = renderWaveBody(2, good, [u("a"), u("b", "NOT_PROVEN", ["no oracle"])]);
    expect(body).toContain(".loki/receipts/a.json");
    expect(body).toContain("a".repeat(64));
    expect(body).toContain("NOT_PROVEN");
    expect(body).toContain("no oracle");
    expect(renderWaveBody(2, bad, [u("a")])).toContain("wave 2 blocked: build failed (exit 1)");
    expect(renderWaveBody(2, null, [u("a")])).toContain("not verified");
  });
  it("writes the body file passed to the push script", () => {
    const s = setup(created);
    s.ship([u("a")], good);
    const bodyFile = s.calls[0]![4]!;
    expect(readFileSync(bodyFile, "utf8")).toContain(".loki/receipts/a.json");
    s.done();
  });
  it("reports failure, never a PR, when gh fails or prints no URL", () => {
    const s = setup(() => ({ status: 1, stdout: "", stderr: "gh: boom" }));
    const r = s.ship([u("a")], good);
    expect(r.shipped).toBe(false);
    expect(r.reason).toContain("gh: boom");
    expect(readModernizeEvents(s.dir, MID).some((e) => e.type === "wave.shipped")).toBe(false);
    s.done();
    const t = setup(() => ({ status: 0, stdout: "garbage\n", stderr: "" }));
    expect(t.ship([u("a")], good).shipped).toBe(false);
    t.done();
  });
});
