// Proof that the semantic route matrix bites: each mutation edits a COPY of src/ and the matrix must report violations.
// The first ten entries are the bypass forms that defeated the old line-regex guard; the rest are the standing mutation list.
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matrixViolations } from "./route_matrix_lib.ts";

const LOKI_TS = join(import.meta.dir, "../..");
const HAIKU = '"claude-haiku-5-5"';
type Edit = [file: string, from: string, to: string];
const PR = "runner/router/plan_route.ts", IMPL = "engine10/stages/implement.ts", FIX = "engine10/stages/fix.ts", UM = "runner/router/unit_model.ts", MR = "runner/model_rank.ts", MACH = "engine10/machine.ts";
const SEND = "let session = await ctx.sessions.run(first);";

const MUTATIONS: { name: string; edits: Edit[] }[] = [
  { name: "B1 let current = haiku literal", edits: [[IMPL, "let current = rr ? rr.model : ctx.model;", `let current = ${HAIKU};`]] },
  { name: "B2 start model helper returns resolveModelAlias(haiku)", edits: [[UM, 'model: runFloor(runModel), source: "default"', 'model: resolveModelAlias("haiku"), source: "default"']] },
  { name: "B3 Object.assign(first, { model: haiku })", edits: [[IMPL, SEND, `Object.assign(first, { model: ${HAIKU} }); ${SEND}`]] },
  { name: "B4 split-line first\\n.model =", edits: [[IMPL, "if (rr) { if (routerPinsAllowed()) first.model = current;", `if (rr) { first\n.model = ${HAIKU};`]] },
  { name: "B5 first[\"model\"] =", edits: [[IMPL, "if (rr) { if (routerPinsAllowed()) first.model = current;", `if (rr) { first["model"] = ${HAIKU};`]] },
  { name: "B6 spread copy {...first, model: haiku} to sessions.run", edits: [[IMPL, SEND, `let session = await ctx.sessions.run({ ...first, model: ${HAIKU} });`]] },
  { name: "B7 fix pin computed from a haiku literal", edits: [[UM, "const carried = String(out[\"fix\"]?.[\"model\"] ?? out[\"implement\"]?.[\"route_model\"] ?? rec.model);", `const carried = ${HAIKU};`]] },
  { name: "B8a model_rank climb returns haiku", edits: [[MR, "to: resolveModelAlias(next)", 'to: resolveModelAlias("haiku")']] },
  { name: "B8b unit_model routedFix pin returns haiku", edits: [[UM, "return { pin: climbed?.to ?? (cur !== runModel ? cur : undefined), climbed };", `return { pin: ${HAIKU}, climbed };`]] },
  { name: "B9 const actualModel = haiku in fix.ts (flows into prior.fix.model)", edits: [[FIX, "const actualModel = routedPin ?? pinnedModel ?? ctx.model;", `const actualModel = ${HAIKU};`]] },
  { name: "B10 fake same-line route record", edits: [[IMPL, "if (rr) { if (routerPinsAllowed()) first.model = current; ctx.emit(\"route\", \"implement\", { unit, model: current, source: rr.source, reason: rr.reason }); }", `if (rr) { first.model = ${HAIKU}; ctx.emit("route", "implement", { unit, model: current, source: rr.source, reason: rr.reason }); }`]] },
  { name: "M1 fix.ts pins haiku on the router branch", edits: [[FIX, "...(routedPin ? { model: routedPin } : {}) },", `...(routedPin ? { model: ${HAIKU} } : {}) },`]] },
  { name: "M2 carried below-run model no longer floored", edits: [[UM, "const cur = !rec.valid && modelRank(carried) < modelRank(floor) ? floor : carried;", "const cur = carried;"]] },
  { name: "M3 route_not_proven ignored", edits: [[UM, "(Array.isArray(np) && np.length > 0)", "false"]] },
  { name: "M4 empty reason accepted", edits: [[UM, 'typeof r["reason"] !== "string" || r["reason"].trim() === "" || ', ""]] },
  { name: "M5 legacy plan.route accepted as a record", edits: [[UM, "const units = plan?.[\"units\"], np", "const units = plan?.[\"units\"] ?? (plan?.[\"route\"] ? [{ id: \"u\", executor: \"haiku\", reason: \"r\" }] : undefined), np"]] },
  { name: "M6 plan stage pins haiku", edits: [[PR, 'pin: pinOpus ? { model: "opus" } : {},', 'pin: routed ? { model: "haiku" } : {},']] },
  { name: "O1 override check removed (routerPinsAllowed always true)", edits: [[UM, "envOverride(env) === null;", "true;"]] },
  { name: "O2 session per-call pin ignores the override", edits: [["engine10/session.ts", "(routerPinsAllowed() ? floorNoAdvisor(opts.model, cfg.advisor) : undefined)", "floorNoAdvisor(opts.model, cfg.advisor)"]] },
  { name: "O3 implement escalation climbs over the override", edits: [[IMPL, "if (routed && routerPinsAllowed() && !signal.aborted) {", "if (routed && !signal.aborted) {"]] },
  { name: "O4 plan Opus pin ignores the override", edits: [[PR, " && envOverride(env) === null;", ";"]] },
  { name: "O5 routedFix pins over the override", edits: [[UM, "  if (!routerPinsAllowed()) return { pin: undefined, climbed: null };\n", ""]] },
  { name: "O6 routeRecord honors a haiku record over the override", edits: [[UM, "const v = routerPinsAllowed() ? validHaikuRoute(plan) : null;", "const v = validHaikuRoute(plan);"]] },
  { name: "M7 lint-only stall climbs (code-owned gate removed)", edits: [[UM, "const climbed = tests > 0 && (o.repeated", "const climbed = (o.repeated"]] },
  { name: "M8 unitRedo dropped (haiku unit not redone on sonnet)", edits: [[UM, '=== "redo-sonnet"; // B4', '=== "never"; // B4']] },
  { name: "M9 every plan is treated as a valid haiku record", edits: [[UM, "export function validHaikuRoute(plan: Record<string, unknown> | undefined): { reason: string } | null {", 'export function validHaikuRoute(plan: Record<string, unknown> | undefined): { reason: string } | null {\n  if (plan !== undefined || plan === undefined) return { reason: "x" };']] },
  { name: "M10 machine stall climb skips the shared decision", edits: [[MACH, "routedFix(ctx.model, outputs, { repeated: false, stall: true, groups: (outputs.verify?.failures_grouped as { signature: string }[] | undefined) ?? [], reason: sigs[sigs.length - 1] ?? \"\" }).climbed", "({ unit: \"run\", from: ctx.model, to: ctx.model, trigger: \"stall\", evidence: \"\" })"]] },
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
