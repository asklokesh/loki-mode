// Helper for tests/test-parity-goal-score.sh. Not a test itself.
// usage: bun goal-score-parity-corpus.ts <goal_score.ts> <run.sh> <outdir>
// Writes <outdir>/corpus.txt (one goal per line) and <outdir>/ts/<n>.out, the
// real goalSharpeningInstruction() result for each corpus line.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [tsPath, shPath, outDir] = process.argv.slice(2) as [string, string, string];
const { goalSharpeningInstruction } = await import(tsPath);
const tsSrc = readFileSync(tsPath, "utf8");
const shFull = readFileSync(shPath, "utf8");
const shSrc = shFull.slice(
  shFull.indexOf(`local goal_sharpening_instruction=""`),
  shFull.indexOf("# Compose-first instruction"),
);

// Every alternation group on BOTH sides becomes single-token goals, so an
// alternative added, dropped or renamed on either side flips a corpus line.
const tokens = new Set<string>();
for (const src of [tsSrc, shSrc]) {
  for (const m of src.matchAll(/\(([^()\n]*\|[^()\n]*)\)/g)) {
    const group = (m[1] ?? "").replace(/^\?:/, "");
    for (const alt of group.split("|")) tokens.add(alt);
  }
}
const concrete = (t: string): string =>
  t.replace(/\\d\{3\}|\[0-9\]\{3\}/g, "200").replace(/\\b/g, "").replace(/\?/g, "");

const goals: string[] = [];
for (const t of tokens) {
  const c = concrete(t);
  if (c.trim() === "" || c.includes("\\") || c.includes("[")) continue;
  goals.push(c);
  goals.push(`5 ${c}`);
}
goals.push(
  "", "   ", "make the app", "make it fast", "make it fast and polished",
  "p95 latency under 200ms", "all tests pass", "the /login endpoint returns 200",
  "Reach 90% coverage", "UPPERCASE LATENCY", "Make it beautiful and robust",
  "ship the thing", "build a todo app", "tests pass", "exit code 0",
  "a<=b", "a<b", "a>b", "x>=1", "a<=", "<=b", "a<<b", "a < b", "1<2", "\t \t",
  "  make it fast  ", "\tlatency\t",
  "response time < 2 s", "3.5 mb bundle", "a 5x speedup",
);
const unique = [...new Set(goals)];

mkdirSync(`${outDir}/ts`, { recursive: true });
writeFileSync(`${outDir}/corpus.txt`, unique.join("\n") + "\n");
unique.forEach((g, i) => {
  writeFileSync(`${outDir}/ts/${i}.out`, goalSharpeningInstruction(g, {}));
});
writeFileSync(
  `${outDir}/ts/off.out`,
  goalSharpeningInstruction("make it fast", { LOKI_GOAL_SCORING: "0" }),
);
console.log(`corpus=${unique.length}`);
