// VPR-2: the fail-to-pass (F2P) check for `loki verify-pr`. A check derived from the LINKED ISSUE must FAIL on the PR
// base and PASS on the PR head. Pure decision logic plus check extraction; execution is injected (the VPR-1 sandbox).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { REPORT_RUNNERS } from "../engine10/testmap.ts";
export interface SandboxResult { status: "COMPLETED" | "TIMEOUT" | "ERROR" | "BLOCKED"; exit_code: number | null; detail?: string; output?: string; report?: string }
export type F2pOutcome =
  | { ok: true }
  | { ok: false; blocked: boolean; reason: string };

const MAX_CHECKS = 5;
const MAX_CMD = 500;
/** Runnable checks the issue author wrote: `Check: \`cmd\`` lines and ```loki-check fences. Only the issue body is read, never the PR body. */
export function extractChecks(issueBody: string): string[] {
  const out: string[] = [];
  const add = (c: string): void => { const t = c.trim(); if (t && t.length <= MAX_CMD && !out.includes(t) && out.length < MAX_CHECKS) out.push(t); };
  let fence = false, inCheck = false;
  for (const ln of issueBody.split(/\r?\n/)) {
    const f = /^\s*(```|~~~)\s*(\S*)/.exec(ln);
    if (f) { if (fence) { fence = false; inCheck = false; } else { fence = true; inCheck = f[2] === "loki-check"; } continue; }
    if (fence) { if (inCheck) add(ln); continue; }
    const m = /^\s*(?:[-*+]\s+)?check:\s*`([^`]+)`/i.exec(ln);
    if (m) add(m[1]!);
  }
  return out;
}
/** Repo-relative file paths a check command names that exist in `dir`. Used to detect a check whose test the PR deleted. */
export function referencedFiles(cmd: string, dir: string): string[] {
  return cmd.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => t !== "" && !t.startsWith("-") && !t.startsWith("/") && !t.includes("..") && existsSync(join(dir, t)));
}

/** Placeholder the sandbox adapter swaps for the run's unpredictable report path inside the sandbox. */
export const REPORT_TOKEN = "__LOKI_REPORT__";
export const RECOGNISED_RUNNERS = REPORT_RUNNERS.map((r) => r.runner).join(", ");

/** Rewrites the first recognised runner in `check` so it writes a machine report to REPORT_TOKEN. The report is read back from the file, never from printed output the PR's tests could forge. Runners with no stable report file and unrecognised commands are returned as a reason, never trusted on exit code or printed totals. */
export function reportedCheck(check: string): { cmd: string } | { reason: string } {
  for (const r of REPORT_RUNNERS) {
    const m = new RegExp(String.raw`(?<![\w./-])${r.find.source}`).exec(check);
    if (m) return { cmd: `${check.slice(0, m.index)}${m[0]} ${r.flags.replace("<report>", REPORT_TOKEN)}${check.slice(m.index + m[0].length)}` };
  }
  const why = "no recognised test runner in the check (runners with no stable report file, such as go and cargo, are not accepted)";
  return { reason: `check cannot be proven: ${why}. A Check must run one of ${RECOGNISED_RUNNERS}, which write a pass/fail report file that is read back; an exit code or printed totals alone is not proof: ${check}` };
}

/** True only when the runner-written report (junit xml or json) records at least one passing test and no failure or error. A missing or unparseable report is not a pass. */
export function reportShowsPass(report: string | undefined): boolean {
  const r = (report ?? "").trim();
  if (r === "") return false;
  if (r.startsWith("{")) {
    try {
      const j = JSON.parse(r) as { success?: unknown; numTotalTests?: unknown; numPassedTests?: unknown; numFailedTests?: unknown };
      return j.success === true && j.numFailedTests === 0 && typeof j.numPassedTests === "number" && j.numPassedTests > 0;
    } catch { return false; }
  }
  if (!/<testsuites?[\s>]/.test(r)) return false;
  const cases = (r.match(/<testcase\b/g) ?? []).length;
  const skipped = (r.match(/<skipped\b/g) ?? []).length;
  const bad = (r.match(/<(?:failure|error)\b/g) ?? []).length;
  const counted = [...r.matchAll(/\b(?:failures|errors)="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
  return cases - skipped > 0 && bad === 0 && counted === 0;
}

/** Reads `path` and applies `test` to its text; an unreadable file counts as a hit (fail closed). */
function textMatchesOrUnreadable(path: string, test: (txt: string) => boolean): boolean {
  try { return test(readFileSync(path, "utf8")); } catch { return true; }
}

/** Changed in a PR, these always count as runner config whatever they hold: transpiler config (babel), interpreter startup hooks (sitecustomize.py, usercustomize.py, *.pth), mocha config, and anything under a __mocks__ directory (the runner applies those without the test asking, and a `roots` setting can move them out of the repo root). */
const ALWAYS_CONFIG = /(?:^|\/)(?:babel\.config\.[\w.]+|\.babelrc(?:\.[\w.]+)?|(?:site|user)customize\.py|[^/]+\.pth|\.mocharc(?:\.[\w.]+)?)$|(?:^|\/)__mocks__\//;
function pluginMods(txt: string): string[] {
  const dotted = (m: RegExpMatchArray) => m[1]!.replace(/\./g, "/");
  const named = [...txt.matchAll(/\bpytest_plugins\s*(?::[^=\n]{0,200})?=\s*(\[[^\]]{0,4096}\]|\([^)]{0,4096}\)|["'][^"'\n]{0,4096}["'])/g)].flatMap((g) => [...g[1]!.matchAll(/["']([\w.]+)["']/g)].map(dotted));
  return [...[...txt.matchAll(/(?:^|[\s"'\[,])-p["']?(?:\s*,)?\s*["']?([\w.]+)(?![\w.:])/g)].map(dotted), ...named];
}
/** Repo paths named by a runner config at the root or in an ancestor dir of a changed file, at either side: quoted paths in a REPORT_RUNNERS config (setup files, global setup, module mapper targets, preload; only the runner's `key` of a shared manifest) and pytest plugin modules (`-p`, bare, quoted or list form, in an ini, cfg or toml config; `pytest_plugins` in conftest.py; a dotted name maps to a path). Editing such a file changes what the runner loads even when the config itself is unchanged. */
function configRefs(changed: readonly string[], roots: readonly string[]): Set<string> {
  const out = new Set<string>(), dirs = new Set(changed.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/")).concat("")));
  for (const root of new Set(roots)) for (const d of dirs) for (const n of (() => { try { return readdirSync(join(root, d)); } catch { return []; } })()) {
    const r = REPORT_RUNNERS.find((x) => x.config.test(n)), ini = /\.(?:ini|cfg)$|^pyproject\.toml$|^conftest\.py$/.test(n); let txt: string;
    if ((!r && !ini) || (n.endsWith(".py") && n !== "conftest.py")) continue; try { txt = readFileSync(join(root, d, n), "utf8"); if (r?.key && !n.startsWith(r.runner)) txt = JSON.stringify((JSON.parse(txt) as Record<string, unknown>)[r.key] ?? ""); } catch { continue; }
    for (const t of ini ? pluginMods(txt) : [...txt.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]!.replace(/^<rootDir>\//, ""))) { const p = posix.normalize(posix.join(d, t)); if (/[a-z]/i.test(t) && !/[*?^$|()[\]\\{}<>\s]/.test(t) && !t.startsWith("/") && !p.startsWith("..")) out.add(p); }
  }
  return out;
}
/** Files the PR added, changed, renamed or deleted that configure or preload the test runner: each REPORT_RUNNERS entry's config file, and any ini, cfg or toml file with a section header naming a test runner (`[...test...]`). Both the base and the head version are judged, so a runner section or key removed from a file that stays (a shared ini, cfg or json config) counts like a deleted file. A config file named for its runner is always config; the `key` check applies only to a shared manifest such as the project manifest. A read failure or a path missing at both sides counts as config (fail closed). The PR's own code could end the run early or redirect which tests run, so the check cannot be trusted. */
export function runnerConfigChanged(changed: readonly string[], headDir: string, baseDir: string = headDir): string[] {
  const refs = configRefs(changed, [headDir, baseDir]);
  return changed.filter((f) => {
    const b = basename(f), r = REPORT_RUNNERS.find((x) => x.config.test(b));
    if (ALWAYS_CONFIG.test(f) || refs.has(f) || refs.has(f.replace(/\.[^./]+$/, "")) || refs.has(f.replace(/\/__init__\.py$/, ""))) return true;
    const at = [headDir, baseDir].filter((d, i, a) => a.indexOf(d) === i && existsSync(join(d, f)));
    if (/^tsconfig[\w.-]*\.json$/.test(b)) return at.length === 0 || at.some((d) => textMatchesOrUnreadable(join(d, f), (txt) => /"(?:paths|baseUrl|rootDirs|extends)"\s*:/.test(txt)));
    if (at.length === 0 || (r && !r.key)) return !!r || at.length > 0;
    if (!r && !/\.(?:ini|cfg|toml)$/.test(f)) return false;
    return at.some((d) => textMatchesOrUnreadable(join(d, f), (txt) => r ? !r.key || b.startsWith(r.runner) || r.key in (JSON.parse(txt) as object) : /^\s*\[[^\]\n]*test|^[ \t]*[\w."' \t-]*\bpytest\b["']?[ \t]*(?:\.|=[ \t]*\{)/im.test(txt)));
  });
}

/** Decides one check. `base` must exit non-zero and `head` must exit zero AND its runner-written report must show a pass (a bare exit 0 is not proof); any sandbox non-completion is NOT PROVEN, never a pass or a fail. */
export function judgeF2p(check: string, base: SandboxResult, head: SandboxResult): F2pOutcome {
  for (const [side, r] of [["base", base], ["head", head]] as const) {
    if (r.status === "BLOCKED") return { ok: false, blocked: true, reason: `sandbox blocked on ${side}: ${r.detail ?? "unavailable"}` };
    if (r.status !== "COMPLETED" || r.exit_code === null) return { ok: false, blocked: false, reason: `check did not complete on ${side} (${r.status}): ${check}` };
  }
  if (base.exit_code === 0) return { ok: false, blocked: false, reason: `check does not discriminate (passes on base): ${check}` };
  if (head.exit_code !== 0) return { ok: false, blocked: false, reason: `check still fails on head (exit ${head.exit_code}): ${check}` };
  if (!reportShowsPass(head.report)) return { ok: false, blocked: false, reason: `exit 0 without a runner report showing a passing test on head, so not proof: ${check}` };
  return { ok: true };
}
