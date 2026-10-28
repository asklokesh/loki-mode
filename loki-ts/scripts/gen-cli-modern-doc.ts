// Regenerates docs/CLI-INVENTORY.md from the command registry.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDoc } from "../src/cli/inventory_doc.ts";
import { REPO_ROOT } from "../src/util/paths.ts";

writeFileSync(join(REPO_ROOT, "docs", "CLI-INVENTORY.md"), renderDoc(REPO_ROOT));
