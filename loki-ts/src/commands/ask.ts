// `loki ask "<question>"`: cited answer from the project's own knowledge (README, docs, decision records, loki.yaml knowledge sources, and the other
// repositories of a workspace). Extractive and deterministic: no model call, no network. `loki wiki ask` stays the model-written answer over code.
import { answerFrom } from "../util/knowledge.ts";
import { redactSecrets } from "../util/redact.ts";
import { BOLD, NC, RED } from "../util/colors.ts";

const HELP = `${BOLD}loki ask${NC} - cited answer from the project's docs and workspace repositories

Usage: loki ask "<question>" [--json]

Reads README, CONTRIBUTING, docs/, decision records and anything named under knowledge: in loki.yaml
(docs, files, repos). repos: names workspace repositories (workspaces: entries with a local path).
Prints the best matching passages, each cited as path:first-last line. LOKI_KNOWLEDGE=0 does not affect this command.
`;

export async function runAsk(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest.includes("--help") || rest.includes("-h")) { process.stdout.write(HELP); return 0; }
  const question = rest.join(" ").trim();
  if (!question) { process.stderr.write(`${RED}loki ask needs a question.${NC}\n${HELP}`); return 2; }
  const { passages, skipped } = answerFrom(process.cwd(), question);
  const cite = (p: { label: string; start: number; end: number }): string => `${p.label}:${p.start}-${p.end}`;
  if (json) {
    process.stdout.write(JSON.stringify({ question, passages: passages.map((p) => ({ source: cite(p), text: redactSecrets(p.text) })), skipped }) + "\n");
    return passages.length > 0 ? 0 : 1;
  }
  if (passages.length === 0) { process.stdout.write("No passage in the project's docs matches that question.\n" + skipped.map((s) => `skipped ${s}\n`).join("")); return 1; }
  process.stdout.write(passages.map((p, i) => `[${i + 1}] ${cite(p)}\n${redactSecrets(p.text)}\n`).join("\n") + skipped.map((s) => `\nskipped ${s}`).join("") + "\n");
  return 0;
}
