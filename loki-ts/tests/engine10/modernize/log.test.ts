// M-01: modernize event types, log wrapper and state paths.
// select: walk-all-src
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

/** FC-M25W-b / M-25w-c: a producer is the event name as a string literal inside a real `append(` call (word boundary before append) on one line.
 *  Comments are blanked and string literals are lifted out first, so `append(` or a `//` inside a string never counts or hides code. */
export const hasProducer = (text: string, name: string): boolean => {
  const strs: string[] = [];
  let code = "";
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); const end = e < 0 ? text.length : e + 2; code += text.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      strs.push(text.slice(i + 1, j));
      code += `\u0001${strs.length - 1}\u0002`;
      i = j + 1;
      continue;
    }
    code += c; i++;
  }
  for (const m of code.matchAll(/\bappend\(([^\n]*)/g)) {
    for (const s of m[1]!.matchAll(/\u0001(\d+)\u0002/g)) if (strs[Number(s[1])] === name) return true;
  }
  return false;
};

describe("event producers (FC-M25W, FC-M25W-b)", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
  it("every event name in types.ts has an append( producer in loki-ts/src (empty allowlist)", () => {
    const src = join(import.meta.dir, "..", "..", "..", "src");
    const typesFile = join(src, "engine10", "modernize", "types.ts");
    const texts = walk(src).filter((f) => f !== typesFile).sort().map((f) => readFileSync(f, "utf8")); // per file, never joined: the scanner is not a JS lexer, so a stray quote or backtick in one file (for example inside a regex) must not swallow the next file, and the result must not depend on directory order
    expect(MODERNIZE_EVENT_TYPES.filter((t) => !texts.some((x) => hasProducer(x, t)))).toEqual([]);
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
  it("M-25w-c: fakes are rejected, a real call beside a URL string is kept", () => {
    const n = "unit.resliced";
    expect(hasProducer('const s = "log.append(\\"unit.resliced\\", {})";', n)).toBe(false);
    expect(hasProducer("const s = 'x append(\"unit.resliced\")';", n)).toBe(false);
    expect(hasProducer('/* log.append("unit.resliced", {}); */', n)).toBe(false);
    expect(hasProducer('xs.myappend("unit.resliced", {});', n)).toBe(false);
    expect(hasProducer('log.append("unit.resliced", { url: "http://x" });', n)).toBe(true);
    expect(hasProducer('const u = "http://x"; log.append("unit.resliced", {});', n)).toBe(true);
    expect(hasProducer("log.append(`unit.resliced`, {});", n)).toBe(true);
  });
  it("M-25w-c: the walk marker stays on line 2", () => {
    expect(readFileSync(join(import.meta.dir, "log.test.ts"), "utf8").split("\n")[1]).toBe("// select: walk-all-src");
  });
});
