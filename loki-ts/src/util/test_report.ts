// util/check_result.ts parses a runner's printed text; this module reads the machine-readable report file a runner writes when asked, a different input. No existing module reads JUnit or jest JSON.
// VERIFY-PLAN V5 (LOKI_E10_STRUCTURED_RESULTS, off by default; observe compares the report with the text parse, enforce is accepted and behaves as observe).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ruleMode } from "../engine10/closure.ts";

export interface TestReport { source: "junit" | "jest-json"; run: number; failed: number; skipped: number; failedIds: string[] }
export const structuredResultsMode = (env: NodeJS.ProcessEnv = process.env) => ruleMode("LOKI_E10_STRUCTURED_RESULTS", "off", env);

const isPytest = (args: readonly string[]): boolean => args.some((a, i) => a === "-m" && args[i + 1] === "pytest");
const isBun = (cmd: string, args: readonly string[]): boolean => basename(cmd) === "bun" && args[0] === "test";
const isVitest = (cmd: string, args: readonly string[]): boolean => basename(cmd) === "npx" && args.includes("vitest") && args.includes("run");
const isJest = (cmd: string, args: readonly string[]): boolean => basename(cmd) === "npx" && args.includes("jest");

/** Which report this per-file command can write, or null when Loki knows none for it (the shapes runnerCmd builds, check_result.ts). */
export const reportSource = (cmd: string, args: readonly string[]): TestReport["source"] | null =>
  isPytest(args) || isBun(cmd, args) || isVitest(cmd, args) ? "junit" : isJest(cmd, args) ? "jest-json" : null;

/** The extra arguments that make this per-file command write its report to `file`, or null when Loki knows no report for it. */
export function reportArgs(cmd: string, args: readonly string[], file: string): string[] | null {
  if (isPytest(args)) return ["--junitxml=" + file, "-o", "junit_family=xunit1"];
  if (isBun(cmd, args)) return ["--reporter=junit", "--reporter-outfile=" + file];
  if (isVitest(cmd, args)) return ["--reporter=default", "--reporter=junit", "--outputFile.junit=" + file];
  if (isJest(cmd, args)) return ["--json", "--outputFile=" + file];
  return null; // go already streams -json; unittest, node, mocha, ava, cargo, maven, gradle, javac, dotnet and a repo command through bash -c have none
}

const decode = (s: string): string => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (attrs: string, name: string): string | null => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(attrs); return m ? decode(m[1]!) : null; };

function readJunit(text: string): TestReport | null {
  if (!/<testsuites?\b/.test(text) || !/<\/testsuites?>\s*$/.test(text.trim() + "\n")) return null; // a truncated file has no closing tag
  let run = 0, failed = 0, skipped = 0; const failedIds: string[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const attrs = m[1] ?? "", body = m[3] ?? "";
    if (/<skipped\b/.test(body)) { skipped++; continue; }
    run++;
    if (!/<(failure|error)\b/.test(body)) continue;
    failed++;
    const name = attr(attrs, "name") ?? "", cls = attr(attrs, "classname") ?? "", file = attr(attrs, "file");
    if (file) {
      const mod = file.replace(/\.[^./]+$/, "").replace(/\//g, ".");
      const rest = (cls.startsWith(mod) ? cls.slice(mod.length) : cls).split(".").filter(Boolean);
      failedIds.push([file, ...rest, name].join("::"));
    } else failedIds.push([cls, name].join(" > "));
  }
  return { source: "junit", run, failed, skipped, failedIds };
}

function readJestJson(text: string): TestReport | null {
  const d = JSON.parse(text) as { testResults?: { assertionResults?: { status?: string; fullName?: string }[] }[] };
  if (!d || !Array.isArray(d.testResults)) return null;
  let run = 0, failed = 0, skipped = 0; const failedIds: string[] = [];
  for (const f of d.testResults) for (const a of Array.isArray(f.assertionResults) ? f.assertionResults : []) {
    if (a.status === "failed") { run++; failed++; failedIds.push(String(a.fullName ?? "")); }
    else if (a.status === "passed") run++;
    else if (a.status === "pending" || a.status === "skipped" || a.status === "todo") skipped++;
  }
  return { source: "jest-json", run, failed, skipped, failedIds };
}

/** Reads the report Loki asked for; null when the file is missing, empty or not the expected format. */
export function readReport(file: string, source: TestReport["source"]): TestReport | null {
  try {
    const text = readFileSync(file, "utf8");
    if (!text.trim()) return null;
    return source === "junit" ? readJunit(text) : readJestJson(text);
  } catch { return null; }
}
