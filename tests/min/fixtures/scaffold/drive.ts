// usage: bun drive.ts <repoDir> <baseSha> <taskFile> [--dry]
import { readFileSync } from "node:fs";
import { scaffold } from "../../../../loki-ts/src/e10ext/scaffold.ts";
const [repo, base, taskFile, dry] = process.argv.slice(2);
const t0 = performance.now();
const r = scaffold(repo!, base!, readFileSync(taskFile!, "utf8"), { apply: dry !== "--dry" });
console.log(JSON.stringify({ ...r, ms: Math.round(performance.now() - t0) }, null, 1));
