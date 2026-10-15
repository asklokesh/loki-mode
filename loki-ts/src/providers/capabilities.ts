// LM-004: one capability table per provider and engine, as data. Every row cites the code it was read from.
// "unknown" means the value was not confirmed from a code path; it is never a guess and never a claim of absence.
// Docs (docs/contracts/capabilities.md), `loki provider info|matrix` and the start-line disclosure all read this table.
import { providerSandboxFlags } from "./provider_guard.ts";

export type Engine = "engine10" | "legacy";
export type Tri<T extends string> = T | "unknown";

export interface Capability {
  provider: string;
  engine: Engine;
  /** How the engine invokes the provider. */
  invocation: string;
  /** measured: provider-reported figures; estimated: parsed or size-based, flagged estimated; none: usd stays not measured. */
  cost: Tri<"measured" | "estimated" | "none">;
  /** pre-emptive: killed while a session runs on a priced figure; post-iteration: checked when a session ends; none: no cap. */
  budgetKill: Tri<"pre-emptive" | "post-iteration" | "none">;
  /** Session child killed as a whole process group (SIGTERM, then SIGKILL after a grace). */
  cancelProcessGroup: Tri<"yes" | "no">;
  /** Native sandbox or approval flags the engine passes. */
  sandboxFlags: string[] | "unknown";
  /** Whether the engine seals a verification receipt for a run on this provider. */
  receipt: Tri<"yes" | "no">;
  /** Session resume within a run. */
  resume: Tri<"yes" | "no">;
  /** When the destructive-change scan runs: native = the provider's own hooks gate each call. */
  guardScan: Tri<"native" | "post-iteration" | "none">;
  /** Whether kill blocking is enforced (receipts list "kill blocking not enforced" when not). */
  killBlocking: Tri<"native" | "none">;
  /** Source files the row was derived from. */
  source: string;
}

export const PROVIDERS = ["claude", "codex", "cline", "aider", "opencode"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

const E10_COMMON = "loki-ts/src/engine10/session.ts (detached spawn, killGroupWithGrace, recordCost, watchBudget), loki-ts/src/providers/provider_guard.ts, loki-ts/src/e10ext/budget_cap.ts";
const U = "unknown" as const;

export const CAPABILITIES: Capability[] = [
  { provider: "claude", engine: "engine10", invocation: "Agent SDK query() (default) or claude CLI via loki-ts/src/runner/providers.ts", cost: "measured", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: [], receipt: "yes", resume: "yes", guardScan: "native", killBlocking: "native", source: `${E10_COMMON}; loki-ts/src/runner/providers.ts (LOKI_E10_RESUME_SESSION, claude only)` },
  { provider: "codex", engine: "engine10", invocation: "codex exec --sandbox workspace-write --skip-git-repo-check", cost: "estimated", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("codex"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/providers/provider_cost.ts (ESTIMATED_PROVIDERS); loki-ts/src/runner/providers.ts codexProvider` },
  { provider: "cline", engine: "engine10", invocation: "cline -y", cost: "estimated", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("cline"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/providers/provider_cost.ts; providers/cline.sh` },
  { provider: "aider", engine: "engine10", invocation: "aider --yes-always", cost: "estimated", budgetKill: "post-iteration", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("aider"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/providers/provider_cost.ts (a reported "Cost: $X session" line is used as-is); providers/aider.sh` },
  { provider: "opencode", engine: "engine10", invocation: "opencode run --auto [-m provider/model]", cost: "none", budgetKill: "none", cancelProcessGroup: "yes", sandboxFlags: providerSandboxFlags("opencode"), receipt: "yes", resume: "no", guardScan: "post-iteration", killBlocking: "none", source: `${E10_COMMON}; loki-ts/src/runner/provider_opencode.ts (costMeasured false); loki-ts/src/providers/provider_cost.ts (opencode not in ESTIMATED_PROVIDERS); docs/v10/GUIDE.md provider table` },
  { provider: "claude", engine: "legacy", invocation: "claude --dangerously-skip-permissions (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/claude.sh (PROVIDER_AUTONOMOUS_FLAG); autonomy/run.sh (LOKI_BUDGET_LIMIT); other fields not confirmed" },
  { provider: "codex", engine: "legacy", invocation: "codex exec --sandbox workspace-write --skip-git-repo-check (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: ["--sandbox", "workspace-write"], receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/codex.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
  { provider: "cline", engine: "legacy", invocation: "cline -y (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/cline.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
  { provider: "aider", engine: "legacy", invocation: "aider --yes-always (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/aider.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
  { provider: "opencode", engine: "legacy", invocation: "opencode run --auto (bash loop)", cost: U, budgetKill: U, cancelProcessGroup: U, sandboxFlags: U, receipt: U, resume: U, guardScan: U, killBlocking: U, source: "providers/opencode.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed" },
];

export const capabilitiesFor = (provider: string): Capability[] => CAPABILITIES.filter((c) => c.provider === provider);
export const capability = (provider: string, engine: Engine = "engine10"): Capability | undefined => CAPABILITIES.find((c) => c.provider === provider && c.engine === engine);

/** One line naming where a provider falls short of Claude on its engine, or null for Claude and for a provider with no gap (nothing is printed then). */
export function disclosureLine(provider: string, engine: Engine = "engine10"): string | null {
  if (provider === "claude") return null;
  const row = capability(provider, engine), base = capability("claude", engine);
  if (!row || !base) return null;
  const d: string[] = [];
  if (row.cost !== base.cost && row.cost !== "unknown") d.push(row.cost === "none" ? "cost not measured" : `cost ${row.cost}`);
  if (row.budgetKill !== base.budgetKill && row.budgetKill !== "unknown") d.push(row.budgetKill === "none" ? "no budget kill" : `budget kill ${row.budgetKill}, not pre-emptive`);
  if (row.guardScan !== base.guardScan && row.guardScan !== "unknown") d.push(`guard scan ${row.guardScan}`);
  if (row.killBlocking !== base.killBlocking && row.killBlocking !== "unknown") d.push("kill blocking not enforced");
  if (row.resume !== base.resume && row.resume !== "unknown") d.push("no session resume");
  return d.length ? `${provider} on ${engine}: ${d.join(", ")}` : null;
}

const cell = (v: string | string[]): string => (Array.isArray(v) ? (v.length ? v.join(" ") : "none") : v);
export const COLUMNS = ["provider", "engine", "cost", "budgetKill", "cancelProcessGroup", "sandboxFlags", "receipt", "resume", "guardScan", "killBlocking"] as const;

export function matrixText(rows: Capability[] = CAPABILITIES): string {
  const head = ["provider", "engine", "cost", "budget kill", "cancel (pgroup)", "sandbox flags", "receipt", "resume", "guard scan", "kill blocking"];
  const body = rows.map((r) => COLUMNS.map((c) => cell(r[c])));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (a: string[]) => a.map((x, i) => x.padEnd(w[i]!)).join("  ").trimEnd();
  return [line(head), ...body.map(line)].join("\n") + "\n";
}

/** Markdown for docs/contracts/capabilities.md. Deterministic: the doc test compares it byte for byte. */
export function renderCapabilitiesMd(): string {
  const out: string[] = [
    "# Backend capability contract (LM-004)",
    "",
    "Generated from `loki-ts/src/providers/capabilities.ts` by `bun scripts/gen-capabilities-doc.ts`. Do not edit by hand.",
    "`unknown` means the value was not confirmed from a code path; it is not a claim that the guarantee is absent.",
    "",
    "Field meanings:",
    "",
    "- cost: `measured` = provider-reported figures; `estimated` = parsed or size-based and flagged estimated; `none` = reported as not measured.",
    "- budget kill: `post-iteration` = no further stage starts once priced cost reaches the cap; `pre-emptive` = killed mid-session on a priced figure; `none` = no cap applies.",
    "- cancel (pgroup): the session child is killed as a whole process group.",
    "- guard scan: `native` = the provider's own hooks gate each call; `post-iteration` = diff scan after each iteration, reverting destructive changes.",
    "- kill blocking: `native` = enforced; `none` = receipts list `kill blocking not enforced`.",
    "",
    "## Matrix",
    "",
    "| provider | engine | cost | budget kill | cancel (pgroup) | sandbox flags | receipt | resume | guard scan | kill blocking |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...CAPABILITIES.map((r) => `| ${COLUMNS.map((c) => cell(r[c])).join(" | ")} |`),
    "",
    "## Invocation and sources",
    "",
    ...CAPABILITIES.map((r) => `- ${r.provider} on ${r.engine}: \`${r.invocation}\`. Source: ${r.source}.`),
    "",
    "## Disclosure before reliance",
    "",
    "`loki start` prints one line before the run when the provider falls short of Claude on engine10. Claude prints nothing extra.",
    "",
    ...PROVIDERS.filter((p) => p !== "claude").map((p) => `- ${disclosureLine(p) ?? `${p}: no difference from claude`}`),
    "",
  ];
  return out.join("\n");
}
