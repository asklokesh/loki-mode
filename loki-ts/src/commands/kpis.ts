// loki-ts/src/commands/kpis.ts -- Phase K MVP (v7.5.28) `loki kpis` subcommand.
//
// Read-only KPI snapshot derived from existing .loki/ state. No new
// instrumentation; pure derivation from .loki/metrics/efficiency/*.json +
// .loki/council/votes/round-*.json.
//
// Usage:
//   loki report kpis     -- pretty-print to stdout (canonical, v7.31 Phase B)
//   loki kpis            -- deprecated alias of `report kpis` (prints pointer)
//   loki report kpis --json   -- machine-readable JSON
//   loki report kpis --help   -- usage
//
// CLI consolidation (Phase B): `report kpis` is the canonical form and `kpis`
// is the deprecated alias. kpis is Bun-only -- it reuses the canonical cost
// arithmetic in runner/budget.ts (the PRICING map + calculateCostFromRecords,
// which is the cost single-source-of-truth). A bash re-implementation would
// duplicate that arithmetic and risk drift, so kpis is NOT ported to bash; on
// the bash route both forms print an honest Bun-requirement message. On the Bun
// route both forms reach this handler; the bare `kpis` token emits the one-line
// deprecation pointer (alias contract), `report kpis` does not.
//
// Exit codes: 0 on success (including empty state), 1 only on flag parse error.
import { computeKpis, formatKpisHuman, formatKpisJson } from "../metrics/kpis.ts";
import { lokiDir as defaultLokiDir } from "../util/paths.ts";
import { emitDeprecatedAlias } from "../util/deprecated_alias.ts";

const HELP = `loki report kpis -- accuracy + efficiency KPI snapshot (v7.5.28 MVP)

Usage:
  loki report kpis        Pretty-print KPI snapshot
  loki report kpis --json Emit KPIs as JSON
  loki report kpis --help Show this help
  (the old top-level 'loki kpis' still works; it prints a one-line pointer)

Reads from .loki/metrics/efficiency/iteration-*.json and
.loki/council/votes/round-*.json. Missing files yield zero/null KPIs
with explicit notes (not silent failure).

Efficiency KPIs: iteration count, total cost USD, avg cost per iter,
total input/output tokens, model/phase/status breakdowns, durations.

Accuracy KPIs: council rounds, unanimous rate, approval rate,
iteration success rate.

This is the Phase K MVP -- read-only derivation. Per-iteration
emission, dashboard panel, and the loki-bench harness are deferred
follow-ups (see project_v7_5_18_arc_status.md).
`;

export type RunKpisOptions = {
  // When set, this invocation came via the deprecated `kpis` alias rather than
  // the canonical `report kpis`. Emit the one-line stderr pointer (suppressed
  // under --json/-q/--quiet by the shared helper). The canonical form passes
  // nothing, so it emits no pointer.
  aliasOf?: string;
};

export function runKpis(args: readonly string[], opts: RunKpisOptions = {}): number {
  if (opts.aliasOf) {
    emitDeprecatedAlias(opts.aliasOf, "report kpis", args);
  }
  let asJson = false;
  for (const a of args) {
    if (a === "--help" || a === "-h" || a === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === "--json") {
      asJson = true;
      continue;
    }
    // -q / --quiet are the alias-suppression flags from the deprecated-alias
    // contract. They affect only the pointer (handled above by
    // emitDeprecatedAlias), not the snapshot. Accept and ignore them so the Bun
    // route matches the bash route, which tolerates them (the bash kpis arm only
    // special-cases --json and ignores everything else). Without this, the
    // suppression-flag contract path errored on Bun ("unknown arg: -q") while
    // bash succeeded.
    if (a === "-q" || a === "--quiet") {
      continue;
    }
    process.stderr.write(`loki kpis: unknown arg: ${a}\nRun 'loki kpis --help' for usage.\n`);
    return 1;
  }
  const snap = computeKpis(defaultLokiDir());
  process.stdout.write(asJson ? formatKpisJson(snap) + "\n" : formatKpisHuman(snap) + "\n");
  return 0;
}
