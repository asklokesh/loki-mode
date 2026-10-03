// Prints generated command lists from the registry for scripts/generate-stale-zero.sh.
// Usage: bun loki-ts/scripts/gen-command-lists.ts inline|table
import { visibleCommands } from "../src/cli/registry.ts";

const mode = process.argv[2];
const cmds = visibleCommands();
if (mode === "inline") {
  console.log("Commands (generated from `loki-ts/src/cli/registry.ts`; full reference in `docs/CLI-REFERENCE.md`):");
  console.log("");
  console.log(cmds.map((c) => `\`${c.name}\``).join(", "));
} else if (mode === "table") {
  console.log("| Command | Description |");
  console.log("| --- | --- |");
  for (const c of cmds) {
    const aliases = (c.aliases ?? []).filter((a) => !a.startsWith("-"));
    const alias = aliases.length ? ` (alias: ${aliases.map((a) => `\`${a}\``).join(", ")})` : "";
    console.log(`| \`loki ${c.name}\`${alias} | ${c.desc.replace(/\|/g, "\\|")} |`);
    for (const s of c.subcommands ?? []) console.log(`| \`loki ${c.name} ${s.name}\` | ${s.desc.replace(/\|/g, "\\|")} |`);
  }
} else {
  console.error("usage: gen-command-lists.ts inline|table");
  process.exit(64);
}
