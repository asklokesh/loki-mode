// Integration wiring for the CPE page slices (D83). Each slice exports `page`; registering by the
// same id replaces the built-in page that App.tsx registered first. Built-in pages whose route a
// slice now owns under a different id are unregistered so one path maps to one page.
import { registerPage, unregisterPage } from "./registry";
import { page as cost } from "./cost";
import { page as runPage } from "./run";
import type { PageDef } from "./registry";
import type { ComponentType } from "react";
import { page as home } from "./home";
import { page as work } from "./board";
import { page as receipts } from "./receipts";
import { page as runs } from "./runs";
import { page as models } from "./models";
import { page as compose } from "./compose";
import { RunControls } from "./run-controls";
import { page as plans, pickerPage as plansPicker } from "./plans";
import { page as merge } from "./merge";
import { page as risk } from "./risk";

// The run thread takes source/run props; the registry passes route params.
const RunPage = runPage.component;
const run: PageDef = { ...runPage, component: ({ params }) => <RunPage source={params.source} run={params.run} renderSlot={(d, reload) => <RunControls source={params.source!} run={params.run!} status={d.blocked_question ? "BLOCKED" : d.status === "running" || d.verdict === null ? "running" : (d.verdict ?? d.status ?? "")} onChanged={reload} />} /> };

// Slice pages take their own optional props; the registry passes route params. Adapt by
// rendering with defaults so every page fits PageDef.
type SlicePage = { id: string; path: string; title: string; component: ComponentType<any>; inSettings?: boolean };
function adapt(p: SlicePage): PageDef {
  const C = p.component;
  return { ...p, component: () => <C /> };
}

export function wirePages(): void {
  unregisterPage("run-detail");
  unregisterPage("new-run");
  registerPage(adapt({ ...home, path: "/" }));
  // Home links runs as /r/:source/:run (spec 3.1); serve it with the run thread.
  registerPage({ ...run, id: "run-short", path: "/r/:source/:run" });
  registerPage(run);
  // Plans reads route params itself, so it registers as-is.
  registerPage(plans);
  registerPage(plansPicker);
  for (const p of [cost, work, receipts, runs, models, compose, merge, risk]) registerPage(adapt(p));
}
