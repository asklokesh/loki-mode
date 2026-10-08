// Contrib bootstrap (D91 / CTO RG-06): the one place that fills core's hook slots (engine10/hooks.ts) and lazy module
// registry. Called once from the CLI entry (src/cli.ts) and from tests/preload.ts. Core never imports contrib/;
// each module is optional, and core falls back to its pre-feature behavior for an empty slot.
import { hooks } from "../engine10/hooks.ts";
import { registerModule } from "../engine10/registry.ts";
import { briefFacts } from "./brief_facts.ts";
import { buildRecords, resumeVerdicts } from "./cost_records.ts";
import { fixEffort, resolveEffort } from "./effort_policy.ts";
import { buildTime, firstEventMs, reconciledTotalS } from "./receipt_time.ts";
import { changedSinceBase, MANIFESTS, snapshotTree } from "./wall_snapshot.ts";

export function registerContrib(): void {
  hooks.time = { build: buildTime, firstEventMs, reconciled: reconciledTotalS };
  hooks.costRecords = { resumeVerdicts, build: buildRecords };
  hooks.effort = { resolve: (stage, eff) => resolveEffort(stage, eff), fix: (round, codeOwned) => fixEffort(round, codeOwned) };
  hooks.wall = { snapshotTree: (d, s) => snapshotTree(d, s), changedSinceBase, manifests: MANIFESTS };
  hooks.briefFacts = briefFacts;
  registerModule("./plan_cmd.ts", () => import("./plan_cmd.ts"));
  registerModule("./eta.ts", () => import("./eta.ts"));
  registerModule("./forecast.ts", () => import("./forecast.ts"));
}
