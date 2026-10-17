// M-01: modernize event types, log wrapper and state paths.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import {
  estimatePath, inventoryPath, isModernizeId, makeModernizeId, modernizeEventsPath,
  MODERNIZE_EVENT_TYPES, modernizeRoot, oracleDir, planPath, reportJsonPath, reportMdPath, routesPath, unitCardPath,
} from "../../../src/engine10/modernize/types.ts";

let repoDir = "";
beforeEach(() => { repoDir = mkdtempSync(join(tmpdir(), "e10-mod-log-")); });
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

describe("makeModernizeId", () => {
  it("matches mod-<utc>-<short> and validates", () => {
    const mid = makeModernizeId(new Date("2026-09-28T01:02:03Z"));
    expect(mid).toMatch(/^mod-20260928T010203Z-[0-9a-f]{6}$/);
    expect(isModernizeId(mid)).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isModernizeId("mod-not-an-id")).toBe(false);
    expect(isModernizeId("")).toBe(false);
  });
});

describe("state paths", () => {
  it("all live under <repo>/.loki/modernize/<mid>/", () => {
    const mid = "mod-20260928T010203Z-ab12cd";
    const root = modernizeRoot(repoDir, mid);
    expect(root).toBe(join(repoDir, ".loki", "modernize", mid));
    for (const p of [
      modernizeEventsPath(repoDir, mid), inventoryPath(repoDir, mid), estimatePath(repoDir, mid),
      planPath(repoDir, mid), routesPath(repoDir, mid), reportJsonPath(repoDir, mid), reportMdPath(repoDir, mid),
      oracleDir(repoDir, mid, "u-1"), unitCardPath(repoDir, mid, "u-1"),
    ]) {
      expect(p.startsWith(root)).toBe(true);
    }
    expect(modernizeEventsPath(repoDir, mid)).toBe(join(root, "events.jsonl"));
    expect(unitCardPath(repoDir, mid, "u-1")).toBe(join(root, "units", "u-1.md"));
  });
});

describe("ModernizeLog", () => {
  it("appends run-level events (stage always null) and they read back in order", () => {
    const mid = "mod-20260928T010203Z-ab12cd";
    const log = new ModernizeLog(repoDir, mid, () => "2026-09-28T01:02:04.000Z");
    log.append("modernize.started", { to: "python3" });
    log.append("inventory.completed", { files: 12 });
    const events = readModernizeEvents(repoDir, mid);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("modernize.started");
    expect(events[0]?.stage).toBeNull();
    expect(events[0]?.run).toBe(mid);
    expect(events[0]?.seq).toBe(0);
    expect(events[1]?.type).toBe("inventory.completed");
    expect(events[1]?.seq).toBe(1);
  });

  it("a second ModernizeLog on the same path resumes seq from the file", () => {
    const mid = "mod-20260928T010203Z-ab12cd";
    new ModernizeLog(repoDir, mid).append("modernize.started", {});
    const log2 = new ModernizeLog(repoDir, mid);
    const e = log2.append("estimate.printed", { cost: null });
    expect(e.seq).toBe(1);
  });
});

/** FC-M25W-b: a producer is the event name inside an append( call on one line, before any trailing // comment. A reader (`type == "x"`, `["x"].includes(t)`) or a comment mentioning the name is not a producer. */
export const hasProducer = (text: string, name: string): boolean =>
  new RegExp(`append\\((?:(?!//)[^\\n])*?["'\`]${name.replace(/\./g, "\\.")}["'\`]`).test(text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"));

describe("event producers (FC-M25W, FC-M25W-b)", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
  it("every event name in types.ts has an append( producer in loki-ts/src (empty allowlist)", () => {
    const src = join(import.meta.dir, "..", "..", "..", "src");
    const typesFile = join(src, "engine10", "modernize", "types.ts");
    const text = walk(src).filter((f) => f !== typesFile).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(MODERNIZE_EVENT_TYPES.filter((t) => !hasProducer(text, t))).toEqual([]);
  });
  it("the review mutations are not producers; a real append is", () => {
    const real = 'log.append("unit.resliced", { unit: u });';
    expect(hasProducer(real, "unit.resliced")).toBe(true);
    expect(hasProducer('log.append(ok ? "unit.resliced" : "unit.completed", {});', "unit.resliced")).toBe(true);
    expect(hasProducer('if (e.type == "unit.resliced") {}', "unit.resliced")).toBe(false);
    expect(hasProducer('if (["unit.resliced"].includes(e.type)) {}', "unit.resliced")).toBe(false);
    expect(hasProducer('doIt(); // see "unit.resliced"', "unit.resliced")).toBe(false);
    expect(hasProducer('log.append(kind); // "unit.resliced"', "unit.resliced")).toBe(false);
  });
});
