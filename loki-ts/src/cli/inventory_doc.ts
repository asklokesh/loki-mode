// Renders docs/CLI-INVENTORY.md from the registry (FC-18: nothing hand-maintained).
// Regenerate: bun loki-ts/scripts/gen-cli-modern-doc.ts
// Guard: scripts/generate-stale-zero.sh --check fails when the committed file differs from this output.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, classOf, registryPaths, type CmdClass } from "./registry.ts";

export interface Row {
  command: string;
  where: string;
  cls: CmdClass;
  reason: string;
  migrate: string;
}

export function inventoryRows(): Row[] {
  const rows: Row[] = [];
  for (const c of REGISTRY) {
    const where = c.where === "both" ? "bun route, bash fallthrough" : c.where === "bun" ? "loki-ts/src/cli.ts" : "autonomy/loki";
    rows.push({ command: c.name, where, cls: classOf(c), reason: c.reason ?? c.desc, migrate: c.migrate ?? "" });
    for (const a of c.aliases ?? []) {
      if (a.startsWith("-")) continue;
      rows.push({ command: a, where, cls: classOf(c), reason: `Alias of ${c.name}`, migrate: "" });
    }
  }
  return rows;
}

export function readGaps(repoRoot: string): string[] {
  try {
    return readFileSync(join(repoRoot, "loki-ts", "tests", "fixtures", "cli-registry-known-gaps.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

export function renderDoc(repoRoot: string): string {
  const rows = inventoryRows();
  const counts: Record<string, number> = { KEEP: 0, HIDE: 0, FOLD: 0, REMOVED: 0 };
  for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
  const gaps = readGaps(repoRoot);
  const byTop = new Map<string, number>();
  for (const g of gaps) byTop.set(g.split(" ")[0]!, (byTop.get(g.split(" ")[0]!) ?? 0) + 1);
  const out: string[] = [];
  out.push("# CLI modernization inventory", "");
  out.push("Generated from `loki-ts/src/cli/registry.ts` by `bun loki-ts/scripts/gen-cli-modern-doc.ts`. Do not edit by hand; the registry guard fails when this file is stale.", "");
  out.push("Classes: KEEP (the 11 commands in `loki --help` and completions), HIDE (keeps working, never shown: machine consumers, CI, dev and enterprise ops), FOLD (behavior moves into the command in the Replacement column; the old name stays a hidden alias that runs unchanged; the replacement may not exist yet), REMOVED (no dependent found; bin/loki exits 2 with the replacement line).", "");
  out.push("## Counts", "");
  for (const k of ["KEEP", "HIDE", "FOLD", "REMOVED"]) out.push(`- ${k}: ${counts[k]}`);
  out.push(`- Total rows: ${rows.length}`, `- Registry paths (commands and nested subcommands): ${registryPaths().length}`, "");
  out.push("## Commands", "", "| Command | Where dispatched | Class | Reason | Replacement |", "| --- | --- | --- | --- | --- |");
  for (const r of rows) out.push(`| ${r.command} | ${r.where} | ${r.cls} | ${r.reason} | ${r.migrate.replace(/\|/g, "\\|")} |`);
  out.push("", "## Registry gaps (nested paths dispatched but not yet in the registry)", "");
  if (!gaps.length) out.push("None.");
  else for (const [top, n] of [...byTop.entries()].sort()) out.push(`- ${top}: ${n}`);
  out.push("");
  return out.join("\n");
}
