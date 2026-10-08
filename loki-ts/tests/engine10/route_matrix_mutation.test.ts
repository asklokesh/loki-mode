// Proof that the semantic route matrix bites: each mutation edits a COPY of src/ and the matrix must report violations.
// The first ten entries are the bypass forms that defeated the old line-regex guard; the rest are the standing mutation list.
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FC-34: the matrix imports the (mutated) src copy dynamically. Doing that in THIS process under `bun test --coverage` leaves the
// coverage reporter holding rows for temp files that afterAll has already deleted, and it dies on Linux. So every evaluation runs in a
// child bun process (no --coverage) and returns its violations as JSON. A child that fails never yields a result.
const CHILD = join(import.meta.dir, "route_matrix_child.ts");
async function matrixViolations(root: string): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, CHILD, root], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LOKI_NO_BROWSER: "1" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`route matrix child exited ${code}: ${err.slice(0, 2000)}`);
  const line = out.trim().split("\n").pop() ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error(`route matrix child printed unparsable output: ${out.slice(0, 500)}`); }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) throw new Error(`route matrix child printed a non-array: ${line.slice(0, 500)}`);
  return parsed as string[];
}

const LOKI_TS = join(import.meta.dir, "../..");
const HAIKU = '"claude-haiku-5-5"';
type Edit = [file: string, from: string, to: string];
const PR = "runner/router/plan_route.ts", IMPL = "engine10/stages/implement.ts", FIX = "engine10/stages/fix.ts", UM = "runner/router/unit_model.ts", MR = "runner/model_rank.ts", MACH = "engine10/machine.ts", IR = "runner/router/implement_route.ts", SR = "runner/router/session_route.ts";
const SEND = "let session = await ctx.sessions.run(first);";

const MUTATIONS: { name: string; edits: Edit[] }[] = [
  { name: "B1 route start assigns a haiku literal", edits: [[IR, "first.model = rr.model;", `first.model = ${HAIKU};`]] },
  { name: "B2 start model helper returns resolveModelAlias(haiku)", edits: [[UM, 'model: runFloor(runModel), source: "default"', 'model: resolveModelAlias("haiku"), source: "default"']] },
  { name: "B3 Object.assign(first, { model: haiku })", edits: [[IMPL, SEND, `Object.assign(first, { model: ${HAIKU} }); ${SEND}`]] },
  { name: "B4 split-line first\\n.model =", edits: [[IR, "first.model = rr.model;", `first\n.model = ${HAIKU};`]] },
  { name: "B5 first[\"model\"] =", edits: [[IR, "first.model = rr.model;", `first["model"] = ${HAIKU};`]] },
  { name: "B6 spread copy {...first, model: haiku} to sessions.run", edits: [[IMPL, SEND, `let session = await ctx.sessions.run({ ...first, model: ${HAIKU} });`]] },
  { name: "B7 fix pin computed from a haiku literal", edits: [[UM, "const carried = String(out[\"fix\"]?.[\"model\"] ?? out[\"implement\"]?.[\"route_model\"] ?? rec.model);", `const carried = ${HAIKU};`]] },
  { name: "B8a model_rank climb returns haiku", edits: [[MR, "to: resolveModelAlias(next)", 'to: resolveModelAlias("haiku")']] },
  { name: "B8b unit_model routedFix pin returns haiku", edits: [[UM, "return { pin: climbed?.to ?? (cur !== runModel ? cur : undefined), climbed };", `return { pin: ${HAIKU}, climbed };`]] },
  { name: "B9 const actualModel = haiku in fix.ts (flows into prior.fix.model)", edits: [[FIX, "const actualModel = routedPin ?? pinnedModel ?? ctx.model;", `const actualModel = ${HAIKU};`]] },
  { name: "B10 fake route record beside a haiku assignment", edits: [[IR, "first.model = rr.model;", `first.model = ${HAIKU}; ctx.emit("route", "implement", { source: "x", reason: "y" });`]] },
  { name: "M1 fix.ts pins haiku on the router branch", edits: [[FIX, "...(routedPin ? { model: routedPin } : {}) },", `...(routedPin ? { model: ${HAIKU} } : {}) },`]] },
  { name: "M2 carried below-run model no longer floored", edits: [[UM, "const cur = !rec.valid && modelRank(carried) < modelRank(floor) ? floor : carried;", "const cur = carried;"]] },
  { name: "M3 route_not_proven ignored", edits: [[UM, "(Array.isArray(np) && np.length > 0)", "false"]] },
  { name: "M4 empty reason accepted", edits: [[UM, 'typeof r["reason"] !== "string" || r["reason"].trim() === "" || ', ""]] },
  { name: "M5 legacy plan.route accepted as a record", edits: [[UM, "const units = plan?.[\"units\"], np", "const units = plan?.[\"units\"] ?? (plan?.[\"route\"] ? [{ id: \"u\", executor: \"haiku\", reason: \"r\" }] : undefined), np"]] },
  { name: "M6 plan stage pins haiku", edits: [[PR, 'pin: pinOpus ? { model: "opus" } : {},', 'pin: routed ? { model: "haiku" } : {},']] },
  { name: "O1 override check removed (routerPinsAllowed always true)", edits: [[UM, "envOverride(env) === null;", "true;"]] },
  { name: "O1 override check removed (routerPinsAllowed always true)", edits: [[UM, "envOverride(env) === null;", "true;"]] },
  { name: "O2 session pin applies the router floor over the override", edits: [[SR, "if (!routerActive()) return opts.model;", "if (!routerEnabled()) return opts.model;"]] },
  { name: "O3 implement ladder runs over the override", edits: [[IMPL, "const routed = routerActive();", 'const routed = (await import("../../runner/router/flag.ts")).routerEnabled();']] },
  { name: "O4 plan Opus pin ignores the override", edits: [[PR, " && envOverride(env) === null;", ";"]] },
  { name: "O5 fix stage routes over the override", edits: [[FIX, "const routed = routerActive(), stallEsc", 'const routed = (await import("../../runner/router/flag.ts")).routerEnabled(), stallEsc']] },
  { name: "O6 machine stall climb runs over the override", edits: [[UM, "if (!routerActive() || out", "if (!routerEnabled() || out"]] },
  { name: "W1 Wall parity: router drops every per-call pin under an override", edits: [[SR, "if (!routerActive()) return opts.model;", "if (!routerActive()) return routerEnabled() ? undefined : opts.model;"]] },
  { name: "W2 Wall parity: no-advisor floor applied under an override", edits: [[SR, "if (!routerActive()) return opts.model;", "if (!routerActive()) return routerEnabled() ? floorNoAdvisor(opts.model, advisor) : opts.model;"]] },
  { name: "M7 lint-only stall climbs (code-owned gate removed)", edits: [[UM, "const climbed = tests > 0 && (o.repeated", "const climbed = (o.repeated"]] },
  { name: "M8 unitRedo dropped (haiku unit not redone on sonnet)", edits: [[UM, '=== "redo-sonnet"; // B4', '=== "never"; // B4']] },
  { name: "M9 every plan is treated as a valid haiku record", edits: [[UM, "export function validHaikuRoute(plan: Record<string, unknown> | undefined): { reason: string } | null {", 'export function validHaikuRoute(plan: Record<string, unknown> | undefined): { reason: string } | null {\n  if (plan !== undefined || plan === undefined) return { reason: "x" };']] },
  { name: "M10 machine stall climb skips the shared decision", edits: [[UM, "return routedFix(runModel, out, { repeated: false, stall: true, groups, reason }).climbed;", 'return null;']] },
];

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function mutatedRoot(edits: Edit[]): string {
  const base = mkdtempSync(join(tmpdir(), "loki-rmx-")); dirs.push(base);
  cpSync(join(LOKI_TS, "src"), join(base, "src"), { recursive: true });
  symlinkSync(join(LOKI_TS, "node_modules"), join(base, "node_modules"));
  writeFileSync(join(base, "package.json"), readFileSync(join(LOKI_TS, "package.json")));
  for (const [file, from, to] of edits) {
    const p = join(base, "src", file), s = readFileSync(p, "utf8");
    expect(s.split(from).length - 1).toBe(1); // the anchor must exist exactly once, or the mutation proves nothing
    writeFileSync(p, s.replace(from, () => to));
  }
  return join(base, "src");
}

describe("route matrix mutation proof", () => {
  it("control: an unmutated copy of src is green", async () => {
    expect(await matrixViolations(mutatedRoot([]))).toEqual([]);
  }, 120_000);
  for (const m of MUTATIONS) {
    it(`red: ${m.name}`, async () => {
      const found = await matrixViolations(mutatedRoot(m.edits));
      expect(found.length).toBeGreaterThan(0);
    }, 120_000);
  }
});

describe("FC-34 guard: the parent test process never loads temp src copies", () => {
  it("no tests file builds a temp copy AND evaluates it in-process through route_matrix_lib", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(import.meta.dir)) {
      if (!f.endsWith(".ts") || f === "route_matrix_lib.ts" || f === "route_matrix_child.ts") continue;
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      if (/from\s+["']\.\/route_matrix_lib(\.ts)?["']/.test(src) && /mkdtempSync|mkdtemp\(/.test(src)) offenders.push(f);
      if (/await import\(\s*join\(\s*(root|base|tmp)/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
  it("this file evaluates mutated copies through the child runner", () => {
    const self = readFileSync(join(import.meta.dir, "route_matrix_mutation.test.ts"), "utf8");
    expect(self).toContain("Bun.spawn([process.execPath, CHILD");
    expect(self).not.toMatch(/import\s*\{[^}]*matrixViolations[^}]*\}\s*from/);
  });
});
