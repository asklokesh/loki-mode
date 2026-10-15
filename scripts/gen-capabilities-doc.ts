// Regenerates docs/contracts/capabilities.md from loki-ts/src/providers/capabilities.ts. Usage: bun scripts/gen-capabilities-doc.ts [--check]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderCapabilitiesMd } from "../loki-ts/src/providers/capabilities.ts";

const target = join(resolve(import.meta.dir, ".."), "docs", "contracts", "capabilities.md");
const md = renderCapabilitiesMd();
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(target, "utf8"); } catch { /* missing */ }
  if (cur !== md) { console.error("docs/contracts/capabilities.md is stale; run: bun scripts/gen-capabilities-doc.ts"); process.exit(1); }
} else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, md); }
