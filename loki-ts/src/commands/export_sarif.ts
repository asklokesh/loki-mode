// `loki export --sarif [run-id]`: writes .loki/runs/<id>/findings.sarif from the run receipt plus a secret scan of the run diff.
// Findings are reported, never gating: the exit code does not depend on how many findings there are.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toSarif, type Finding } from "../features/sarif.ts";
import { lokiDir, REPO_ROOT } from "../util/paths.ts";
import { safeGitRun } from "../util/safe_git.ts";

// Tier 1 formats from autonomy/lib/secret-scan.sh. Only the label is ever reported, never the matched text.
const SECRET_PATTERNS: [string, RegExp][] = [
  ["aws-access-key", /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/],
  ["private-key-block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}/],
  ["slack-token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["openai-style-key", /sk-[A-Za-z0-9]{20,}/],
  ["google-api-key", /AIza[0-9A-Za-z_-]{35}/],
  ["gitlab-token", /glpat-[A-Za-z0-9_-]{20,}/],
];
const TEMPLATE_PATH = /\.(example|sample|template|dist)(\.|$)|(^|\/)(fixtures|__fixtures__)\//;

export function scanDiff(diff: string): Finding[] {
  const out: Finding[] = [];
  let file = "";
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.startsWith("+++ b/") ? l.slice(6) : ""; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (l.startsWith("+")) {
      if (file && !TEMPLATE_PATH.test(file)) {
        const hit = SECRET_PATTERNS.find(([, re]) => re.test(l));
        if (hit) out.push({ kind: "secret", message: hit[0], key: hit[0], file, line });
      }
      line++;
    } else if (!l.startsWith("-")) line++;
  }
  return out;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function receiptFindings(receipt: Record<string, unknown>): Finding[] {
  const out: Finding[] = strs(receipt["not_proven"]).map((m) => ({ kind: "not-proven", message: m }));
  const checks = Array.isArray(receipt["checks"]) ? (receipt["checks"] as Record<string, unknown>[]) : [];
  for (const c of checks) if (c["result"] === "fail") out.push({ kind: "verify", message: `check failed: ${String(c["name"] ?? "unnamed")}`, key: String(c["name"] ?? "") });
  return out;
}

function latestRunId(runsRoot: string): string | null {
  if (!existsSync(runsRoot)) return null;
  const dirs = readdirSync(runsRoot).filter((d) => { try { return statSync(join(runsRoot, d)).isDirectory(); } catch { return false; } });
  return dirs.sort().pop() ?? null;
}

const USAGE = "Usage: loki export --sarif [run-id]\nWrite .loki/runs/<run-id>/findings.sarif (SARIF 2.1.0) from the run receipt and a secret scan of the run diff (default: latest run).\nFindings are reported only; they never change a verdict or this command's exit code.\nExit: 0 written, 2 usage error, 66 unknown run or no runs.\n";

export interface ExportSarifDeps { runsRoot?: string; repoDir?: string; diff?: (base: string, head: string) => Promise<string | null> }

export async function main(args: readonly string[], deps: ExportSarifDeps = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) return (process.stdout.write(USAGE), 0);
  const rest = args.filter((a) => a !== "--sarif");
  const bad = rest.find((a) => a.startsWith("-"));
  if (bad || rest.length > 1) return (process.stderr.write(`loki export --sarif: ${bad ? `unknown flag ${bad}` : "more than one run-id"}\n`), 2);
  const runsRoot = deps.runsRoot ?? join(lokiDir(), "runs");
  const runId = rest[0] ?? latestRunId(runsRoot);
  if (!runId) return (process.stderr.write("loki export --sarif: no runs found\n"), 66);
  const runDir = join(runsRoot, runId);
  const receiptPath = join(runDir, "receipt.json");
  if (runId.includes("/") || runId.includes("..") || !existsSync(receiptPath)) return (process.stderr.write(`loki export --sarif: unknown run ${runId}\n`), 66);
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>; } catch { return (process.stderr.write(`loki export --sarif: unreadable receipt for ${runId}\n`), 66); }
  const base = typeof receipt["base_sha"] === "string" ? receipt["base_sha"] : "", head = typeof receipt["head_sha"] === "string" ? receipt["head_sha"] : "";
  const findings: Finding[] = [];
  if (/^[0-9a-f]{40,64}$/.test(base) && /^[0-9a-f]{40,64}$/.test(head) && base !== head) {
    const diff = await (deps.diff ?? ((b, h) => gitDiff(deps.repoDir ?? process.cwd(), b, h)))(base, head);
    if (diff === null) findings.push({ kind: "not-proven", message: "secret scan skipped: run diff could not be computed" });
    else findings.push(...scanDiff(diff));
  }
  findings.push(...receiptFindings(receipt));
  let version = "0.0.0";
  try { version = readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim() || version; } catch { /* keep default */ }
  const out = join(runDir, "findings.sarif");
  writeFileSync(out, JSON.stringify(toSarif(findings, version, deps.repoDir ?? process.cwd()), null, 2) + "\n");
  process.stdout.write(`run: ${runId}\nfindings: ${findings.length}\nwrote: ${out}\n`);
  return 0;
}

async function gitDiff(repoDir: string, base: string, head: string): Promise<string | null> {
  const r = await safeGitRun(repoDir, ["diff", "--no-color", "--no-ext-diff", "--unified=0", "--no-renames", base, head, "--", ".", ":(exclude).loki"], { timeoutMs: 20000 });
  return r.exitCode === 0 ? r.stdout : null;
}
