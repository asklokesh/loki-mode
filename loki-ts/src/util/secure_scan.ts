// Typed wrapper for autonomy/lib/secure-scan.py. argv spawn (no shell), a
// timeout, and a parsed {ok, findings, error?} result. Exit contract of the
// script: 0 no findings, 1 findings, 2 bad input. Anything else, or output
// that is not the expected JSON, is an error (never a silent pass).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { REPO_ROOT } from "./paths.ts";
import { findPython3 } from "./python.ts";
import { safeGitSpawn } from "./safe_git.ts";
import { run } from "./shell.ts";

export interface SecureScanFinding {
  rule: string;
  file: string;
  line: number;
  severity: string;
  message: string;
  fix: string;
}

export interface SecureScanResult {
  ok: boolean;
  findings: SecureScanFinding[];
  error?: string;
}

export interface SecureScanOpts {
  scriptPath?: string;
  timeoutMs?: number;
  /** Apply the token rule to every text file (share bundles), not just browser-served ones. */
  secretsEverywhere?: boolean;
  /**
   * Pre-PR added-line scan (TEN-SECURITY-01). When targetDir is a git work tree
   * root, lines added since this base (committed, uncommitted and untracked) are
   * also checked for provider keys (sk-ant, AIza, xoxb/xoxp, ghp_ and the rest of
   * the scanner's token rule) in EVERY file, not only browser-served ones.
   * Default base: LOKI_SECURE_SCAN_BASE, else the merge-base with origin/HEAD,
   * else with the upstream, else HEAD. false turns the added-line scan off.
   */
  diffBase?: string | false;
}

export const ADDED_LINE_RULE = "provider-key-in-added-line";
const MAX_ADDED_FILE_BYTES = 1_000_000;

export const DEFAULT_SECURE_SCAN_TIMEOUT_MS = 120_000;

function fail(error: string): SecureScanResult {
  return { ok: false, findings: [], error };
}

export async function runSecureScan(targetDir: string, opts: SecureScanOpts = {}): Promise<SecureScanResult> {
  const script = opts.scriptPath ?? join(REPO_ROOT, "autonomy", "lib", "secure-scan.py");
  if (!existsSync(script)) return fail(`secure-scan script not found: ${script}`);
  const py = await findPython3();
  if (!py) return fail("python3 not found");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SECURE_SCAN_TIMEOUT_MS;

  const started = Date.now();
  const res = await run([py, script, targetDir, "--json", ...(opts.secretsEverywhere ? ["--secrets-everywhere"] : [])], { timeoutMs });
  const elapsed = Date.now() - started;

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = undefined;
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;

  if ((res.exitCode === 0 || res.exitCode === 1) && obj && Array.isArray(obj.findings)) {
    const findings = obj.findings as SecureScanFinding[];
    // Exit code and payload must agree; a mismatch is a broken scanner.
    if ((res.exitCode === 1) !== (findings.length > 0)) return fail(`secure-scan exit ${res.exitCode} disagrees with ${findings.length} findings`);
    // A share bundle already applies the token rule everywhere; no diff to scan.
    if (opts.secretsEverywhere || opts.diffBase === false) return { ok: true, findings };
    const added = await scanAddedLines(targetDir, { ...opts, scriptPath: script, timeoutMs });
    if (!added.ok) return added;
    const seen = new Set(findings.map((f) => `${f.file}|${f.line}`));
    return { ok: true, findings: [...findings, ...added.findings.filter((f) => !seen.has(`${f.file}|${f.line}`))] };
  }
  if (res.exitCode !== 0 && res.exitCode !== 1 && res.exitCode !== 2 && elapsed >= timeoutMs) {
    return fail(`secure-scan timed out after ${timeoutMs}ms`);
  }
  if (obj && typeof obj.error === "string") return fail(`secure-scan: ${obj.error}`);
  const tail = (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" | ");
  return fail(`secure-scan failed (exit ${res.exitCode}): ${tail}`);
}

function git(repoDir: string, args: string[]): string | null {
  const r = safeGitSpawn(repoDir, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}

/** True when dir is the root of a git work tree (a subdir or a non-repo has no diff of its own). */
function isWorkTreeRoot(dir: string): boolean {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top === null) return false;
  try {
    return realpathSync(top.trim()) === realpathSync(dir);
  } catch {
    return false;
  }
}

function resolveDiffBase(repoDir: string, explicit: string | undefined): string | null {
  const want = explicit ?? process.env["LOKI_SECURE_SCAN_BASE"];
  if (want) return git(repoDir, ["rev-parse", "--verify", "--quiet", `${want}^{commit}`])?.trim() || null;
  // The default branch first: a pre-PR diff is against what the PR targets.
  for (const ref of ["refs/remotes/origin/HEAD", "@{upstream}"]) {
    const mb = git(repoDir, ["merge-base", "HEAD", ref])?.trim();
    if (mb) return mb;
  }
  return git(repoDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim() || null;
}

/**
 * Path from a `+++ ` diff header: null for /dev/null or a non-b/ side. git
 * appends a tab after a path that contains a space and C-quotes a path with a
 * tab, newline, quote or backslash; both forms are decoded here.
 */
export function parseDiffHeaderPath(header: string): string | null {
  let p = header;
  if (p.startsWith('"')) {
    const bytes: number[] = [];
    let i = 1;
    let closed = false;
    while (i < p.length) {
      const c = String.fromCodePoint(p.codePointAt(i)!);
      if (c === '"') {
        closed = true;
        break;
      }
      if (c !== "\\") {
        for (const b of Buffer.from(c, "utf8")) bytes.push(b);
        i += c.length;
        continue;
      }
      const e = p[i + 1] ?? "";
      const oct = /^[0-7]{3}/.exec(p.slice(i + 1, i + 4));
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += 4;
        continue;
      }
      const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
      if (!(e in esc)) return null;
      bytes.push(esc[e]!);
      i += 2;
    }
    if (!closed) return null;
    p = Buffer.from(bytes).toString("utf8");
  } else if (p.endsWith("\t")) {
    p = p.slice(0, -1);
  }
  return p.startsWith("b/") && p.length > 2 ? p.slice(2) : null;
}

/**
 * Added lines per path (new-file line number to text) from a `git diff -U0`
 * body. Each @@ header's old and new counts bound its hunk, so an added line
 * whose text begins "++ " (rendered "+++ ...") is content, never a file header.
 */
export function parseAddedLines(diff: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  let cur: Map<number, string> | null = null;
  let next = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      if (line.startsWith("+")) {
        if (cur) cur.set(next, line.slice(1));
        next++;
        newLeft--;
      } else if (line.startsWith("-")) {
        oldLeft--;
      } else {
        next++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      cur = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = parseDiffHeaderPath(line.slice(4));
      cur = p === null ? null : (out.get(p) ?? new Map<number, string>());
      if (p !== null && cur) out.set(p, cur);
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      next = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
    }
  }
  return out;
}

/**
 * Scans only the lines added since the diff base. Each changed file is mirrored
 * into a private temp dir with every line blanked except the added ones (line
 * numbers preserved), then the same secure-scan.py token rule runs over the
 * mirror with --secrets-everywhere, so there is one pattern list, not two.
 * Findings name file:line and the key kind; the secret itself is never echoed.
 */
export async function scanAddedLines(repoDir: string, opts: SecureScanOpts = {}): Promise<SecureScanResult> {
  if (opts.diffBase === false || !isWorkTreeRoot(repoDir)) return { ok: true, findings: [] };
  const base = resolveDiffBase(repoDir, opts.diffBase);
  const added = new Map<string, Map<number, string>>();
  if (base) {
    const diff = git(repoDir, ["-c", "core.quotePath=false", "diff", "--src-prefix=a/", "--dst-prefix=b/", "-U0", "--no-color", "--no-ext-diff", "--no-renames", base, "--"]);
    if (diff === null) return fail(`secure-scan: git diff against ${base.slice(0, 12)} failed`);
    for (const [p, lines] of parseAddedLines(diff)) added.set(p, lines);
  }
  const untracked = git(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked === null) return fail("secure-scan: git ls-files failed");
  for (const p of untracked.split("\0").filter(Boolean)) {
    try {
      const st = statSync(join(repoDir, p));
      if (!st.isFile() || st.size > MAX_ADDED_FILE_BYTES) continue;
      const lines = new Map<number, string>();
      readFileSync(join(repoDir, p), "utf8").split("\n").forEach((t, i) => lines.set(i + 1, t));
      added.set(p, lines);
    } catch {
      // unreadable untracked file: nothing to scan
    }
  }
  if (added.size === 0) return { ok: true, findings: [] };

  const mirror = mkdtempSync(join(tmpdir(), "loki-secure-added-"));
  try {
    const root = resolve(mirror) + sep;
    for (const [p, lines] of added) {
      if (lines.size === 0) continue;
      const dest = resolve(mirror, p);
      if (!dest.startsWith(root)) continue;
      const max = Math.max(...lines.keys());
      const body: string[] = [];
      for (let i = 1; i <= max; i++) body.push(lines.get(i) ?? "");
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body.join("\n") + "\n");
    }
    const r = await runSecureScan(mirror, { scriptPath: opts.scriptPath, timeoutMs: opts.timeoutMs, secretsEverywhere: true });
    if (!r.ok) return r;
    // One finding per line. An sk-ant key also matches the generic sk- shape,
    // so a more specific kind on the same line replaces openai-key.
    const byLine = new Map<string, { f: SecureScanFinding; kind: string }>();
    for (const f of r.findings) {
      if (f.rule !== "secret-in-client-file") continue;
      const kind = /A live (\S+)/.exec(f.message)?.[1] ?? "provider key";
      const k = `${f.file}|${f.line}`;
      const prev = byLine.get(k);
      if (!prev || (prev.kind === "openai-key" && kind !== "openai-key")) byLine.set(k, { f, kind });
    }
    const findings = [...byLine.values()]
      .map(({ f, kind }) => {
        return {
          rule: ADDED_LINE_RULE,
          file: f.file,
          line: f.line,
          severity: "HIGH",
          message: `A ${kind} was added at ${f.file}:${f.line}; the value is withheld here.`,
          fix: "Remove the key from the change, rotate it (assume it is compromised), and read it at runtime from an environment variable or secret manager.",
        };
      });
    return { ok: true, findings };
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}
