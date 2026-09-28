// M-24: dashboard /modernize view (docs/v10/MODERNIZE.md, D33). The view lives in
// modernize/dashboard.ts (not dashboard/modernize.ts, per D33), so it can hold a static
// import of modernize/'s own log.ts/types.ts without violating "core never imports modernize".
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog } from "../../../src/engine10/modernize/log.ts";
import { listModernizeIds, modernizeRoute, summarizeModernize } from "../../../src/engine10/modernize/dashboard.ts";

let repoDir = "";
beforeEach(() => { repoDir = mkdtempSync(join(tmpdir(), "e10-mod-dash-")); });
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

describe("listModernizeIds", () => {
  it("is empty when no modernization has run", () => {
    expect(listModernizeIds(repoDir)).toEqual([]);
  });

  it("lists ids sorted, ignoring non-directories", () => {
    new ModernizeLog(repoDir, "mod-20260928T010000Z-aaaaaa").append("modernize.started", { to: "python3" });
    new ModernizeLog(repoDir, "mod-20260928T020000Z-bbbbbb").append("modernize.started", { to: "java21" });
    expect(listModernizeIds(repoDir)).toEqual([
      "mod-20260928T010000Z-aaaaaa",
      "mod-20260928T020000Z-bbbbbb",
    ]);
  });
});

describe("summarizeModernize", () => {
  it("reports unknown status with no events", () => {
    const s = summarizeModernize(repoDir, "mod-missing");
    expect(s).toEqual({ mid: "mod-missing", to: null, status: "unknown", startedTs: null, completedTs: null });
  });

  it("folds started/target/status from the event log, completed left null until it happens", () => {
    const mid = "mod-20260928T010000Z-aaaaaa";
    const log = new ModernizeLog(repoDir, mid, () => "2026-09-28T01:00:00.000Z");
    log.append("modernize.started", { to: "python3" });
    const s = summarizeModernize(repoDir, mid);
    expect(s.to).toBe("python3");
    expect(s.status).toBe("modernize.started");
    expect(s.startedTs).toBe("2026-09-28T01:00:00.000Z");
    expect(s.completedTs).toBeNull();
  });

  it("sets completedTs once modernize.completed is appended", () => {
    const mid = "mod-20260928T010000Z-aaaaaa";
    let now = "2026-09-28T01:00:00.000Z";
    const log = new ModernizeLog(repoDir, mid, () => now);
    log.append("modernize.started", { to: "java21" });
    now = "2026-09-28T02:00:00.000Z";
    log.append("modernize.completed", { verdict: "COMPLETE" });
    const s = summarizeModernize(repoDir, mid);
    expect(s.status).toBe("modernize.completed");
    expect(s.completedTs).toBe("2026-09-28T02:00:00.000Z");
  });
});

describe("modernizeRoute", () => {
  it("renders an HTML page listing every modernization", async () => {
    new ModernizeLog(repoDir, "mod-20260928T010000Z-aaaaaa").append("modernize.started", { to: "python3" });
    const res = modernizeRoute(repoDir);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("mod-20260928T010000Z-aaaaaa");
    expect(body).toContain("python3");
  });

  it("renders a page with no rows when nothing has run yet", async () => {
    const res = modernizeRoute(repoDir);
    const body = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).not.toContain("undefined");
  });
});
