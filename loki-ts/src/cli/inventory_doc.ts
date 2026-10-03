// Renders docs/v10/CLI-MODERN.md from the registry (FC-18: nothing hand-maintained).
// Regenerate: bun loki-ts/scripts/gen-cli-modern-doc.ts
// Guard: loki-ts/tests/cli/registry_guard.test.ts compares the file to this output.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, registryPaths, type CmdClass } from "./registry.ts";

export interface Row {
  command: string;
  where: string;
  cls: CmdClass;
  reason: string;
}

export function inventoryRows(): Row[] {
  const rows: Row[] = [];
  for (const c of REGISTRY) {
    const where = c.where === "both" ? "bun route, bash fallthrough" : c.where === "bun" ? "loki-ts/src/cli.ts" : "autonomy/loki";
    rows.push({ command: c.name + (c.hidden ? " (hidden)" : ""), where, cls: c.cls ?? "KEEP-MODERN", reason: c.reason ?? c.desc });
    for (const a of c.aliases ?? []) {
      if (a.startsWith("-")) continue;
      rows.push({ command: a, where, cls: "DELETE", reason: `Alias of ${c.name}; shown only under 'loki help aliases'` });
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
  const counts: Record<string, number> = { "KEEP-MODERN": 0, UPDATE: 0, "DROP-LEGACY": 0, DELETE: 0 };
  for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
  const gaps = readGaps(repoRoot);
  const byTop = new Map<string, number>();
  for (const g of gaps) byTop.set(g.split(" ")[0]!, (byTop.get(g.split(" ")[0]!) ?? 0) + 1);
  const out: string[] = [];
  out.push("# CLI modernization inventory", "");
  out.push("Generated from `loki-ts/src/cli/registry.ts` by `bun loki-ts/scripts/gen-cli-modern-doc.ts`. Do not edit by hand; the registry guard fails when this file is stale.", "");
  out.push("Classes: KEEP-MODERN (v10-native or engine-neutral), UPDATE (live but needs modernizing), DROP-LEGACY (drives only the legacy engine; removed under LEGACY-ZERO, hidden from help and completions meanwhile), DELETE (deprecated alias).", "");
  out.push("## Counts", "");
  for (const k of ["KEEP-MODERN", "UPDATE", "DROP-LEGACY", "DELETE"]) out.push(`- ${k}: ${counts[k]}`);
  out.push(`- Total rows: ${rows.length}`, `- Registry paths (commands and nested subcommands): ${registryPaths().length}`, "");
  out.push("## Commands", "", "| Command | Where dispatched | Class | Reason |", "| --- | --- | --- | --- |");
  for (const r of rows) out.push(`| ${r.command} | ${r.where} | ${r.cls} | ${r.reason} |`);
  out.push("", "## Registry gaps (nested paths dispatched but not yet in the registry)", "");
  if (!gaps.length) out.push("None.");
  else for (const [top, n] of [...byTop.entries()].sort()) out.push(`- ${top}: ${n}`);
  out.push("");
  return out.join("\n");
}
