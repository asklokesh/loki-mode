// LOKI_HOST_GUARD for Agent SDK sessions: the in-process PreToolUse Bash callback.
//
// autonomy/hooks/validate-bash.sh holds the deny rules (host Docker/process/service/port control, nested
// shells, recursive deletes of a temp root, the dangerous-pattern list, the simple-web contract) and stays the
// CLI route's command hook. Spawning it costs about 0.33 s per Bash call (bash plus four python3 and one node
// start), measured against 0.006 s for bare bash, and nearly every engine command triggers none of its rules.
// So this callback answers in-process when no rule can apply, and runs the script only when one might:
// scriptRuleMayApply is a superset of every deny path in the script (each check is broader than the rule it
// stands for), so a command the script would deny always reaches the script, and its verdict is returned as is.
// The checks that need no script (input shape, workspace cwd, the audit line, the allow or no-decision verdict)
// are ported exactly. tests/min/host-guard.sh compares both on a corpus and plants a defect per rule.

import { appendFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
import { envWithPwd } from "./worker_proc.ts";
import { permissionPolicyMode } from "../providers/claude_flags.ts";
import { allowFor, appendDenial, fenceDenied, fenceEnabled, harnessOutputs } from "../util/config_fence.ts";

// Host-guard hook timeout, seconds. Mirrors _loki_hook_timeout in autonomy/run.sh (same env var, same default, same validation).
export const HOOK_TIMEOUT_DEFAULT_S = 30;
export function hookTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LOKI_HOOK_TIMEOUT"] ?? "";
  return /^[1-9][0-9]{0,4}$/.test(raw) ? Number(raw) : HOOK_TIMEOUT_DEFAULT_S;
}

export const HOST_GUARD_SCRIPT = resolve(REPO_ROOT, "autonomy", "hooks", "validate-bash.sh");

type Decision = { hookSpecificOutput?: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "deny"; permissionDecisionReason?: string } };

export function hostGuardDecision(reason: string): Decision {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}
const ALLOW: Decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };

// Python's str.isspace() set: the script rejects a command that is blank by `command.strip()`.
const PY_SPACE = "[ \\t\\n\\r\\x0b\\x0c\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_BLANK = new RegExp(`^${PY_SPACE}*$`);
// Bash joins backslash-newline continuations (an odd run of backslashes before the newline); the script does too.
const CONTINUATION = /(?<!\\)((?:\\\\)*)\\\r?\n/g;

/** False when Python's posix shlex would raise on this text (unclosed quote, or an escape at the end). */
export function shlexBalanced(text: string): boolean {
  let state = 0; // 0 outside quotes, 1 single, 2 double
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 1) { if (c === "'") state = 0; continue; }
    if (c === "\\") { if (i + 1 >= text.length) return false; i++; continue; }
    if (state === 2) { if (c === '"') state = 0; continue; }
    if (c === "'") state = 1; else if (c === '"') state = 2;
  }
  return state === 0;
}

// A command word, after quotes and backslashes are dropped: preceded by a separator or a path slash (the script
// compares basenames), followed by optional trailing slashes and a separator. Backtick counts as a separator.
const B = "(?:^|[\\s;&|()`/])";
const E = "/*(?=$|[\\s;&|()`])";
const word = (names: string) => new RegExp(`${B}(?:${names})${E}`);
const RM_WORD = word("rm");
const HOST_WORD = word("docker|docker-compose|kill|killall|pkill|sudo|doas|launchctl|service|systemctl|brew|nc|ncat|netcat|socat");
const SHELL_WORD = word("bash|dash|ksh|sh|zsh");
const DASH_C_ARG = /(?:^|[\s;&|()`])-[^\s;&|()`]*c/;
const ENV_WORD = word("env");
const GIT_WORD = /(?:^|[\s;&|()`/])git(?=$|[\s;&|()`])/; // no trailing-slash run: "git" is never a directory here, and word()'s `/*` would let "git/x" through unchanged anyway
const ENV_SPLIT_ARG = /(?:^|[\s;&|()`])(?:-S|--split-string)(?=$|[\s;&|()`])/;
// Raw-text rules: the explicit port claims and the BLOCKED_PATTERNS list, each widened (`.` spans lines, a
// value check dropped, `$\(base64` read literally) so it matches whenever the script's pattern does. Every shape
// "A .* B .* C" is an indexOf chain, never a regex: `[\s\S]*` twice is cubic on a long heredoc of repeated A,
// and this callback runs synchronously in the engine (a 12 KB `curl|` heredoc held it for 9.7 s).

/** True when the steps occur in order, each starting at or after the end of the previous one (any alternative per step).
 *  The earliest-ending alternative at each step leaves the most text for the rest, so one pass decides it. */
export function inOrder(text: string, ...steps: string[][]): boolean {
  let pos = 0;
  for (const alts of steps) {
    let end = -1;
    for (const a of alts) {
      const i = text.indexOf(a, pos);
      if (i >= 0 && (end < 0 || i + a.length < end)) end = i + a.length;
    }
    if (end < 0) return false;
    pos = end;
  }
  return true;
}
const LOKI_STATE = [".loki/council/", ".loki/config.yaml", ".loki/logs/bash-audit", ".loki/session.lock"];
const FORK_HEAD = /:\(\) *\{/;
const RAW_RULES: Array<[string, (c: string) => boolean]> = [
  ["port", (c) => /PORT[\s\x1c-\x1f\x85]*=|--port|--publish|http\.server/.test(c)],
  ["pattern", (c) => /rm -rf (?:\/|~|\$HOME|\.loki|\.\/\.loki)/.test(c)],
  ["pattern", (c) => /> \/dev\/sd|mkfs[. ]|dd if=\/dev\/zero|chmod -R 777 \//.test(c)],
  ["pattern", (c) => inOrder(c, ["eval"], ["base64"]) || inOrder(c, ["base64"], ["|"], ["sh"]) || c.includes("$(base64") || inOrder(c, ["eval"], ["$("])],
  ["pattern", (c) => inOrder(c, ["curl", "wget"], ["|"], ["sh"])],
  ["pattern", (c) => inOrder(c, ["rm "], LOKI_STATE) || c.includes("> .loki/council/") || c.includes("> .loki/config.yaml")],
  ["pattern", (c) => { const m = FORK_HEAD.exec(c); return m !== null && inOrder(c.slice(m.index + m[0].length), ["|"], ["&"]); }],
];
/** The first raw-text rule the command matches ("port" or "pattern"), or null. */
export function rawRule(command: string): string | null {
  for (const [name, hit] of RAW_RULES) if (hit(command)) return name;
  return null;
}

/**
 * The name of the first script rule this command could trigger, or null when none can (the script would allow it).
 * Every check over-approximates its rule, so null is safe to act on and a name only means "ask the script".
 */
export function scriptRuleMayApply(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env["LOKI_SUPERVISED_BUILD"] === "1" && env["LOKI_BUILD_PROFILE"] === "simple-web") return "simple-web";
  if (command.includes("\0")) return "nul"; // bash drops NUL bytes from the script's copy, which can join two words into one
  if (!shlexBalanced(command.replace(/\n/g, " ; "))) return "unparsed";
  const raw = rawRule(command);
  if (raw) return raw;
  // The script reads words with quotes removed (shlex) and with fd duplications (2>&1) cut (the rm check); test both forms.
  for (const text of [command, command.replace(/(?<![0-9])[0-9]*>&[0-9]+/g, "")]) { // the lookbehind enters a digit run once: same matches, linear
    const s = text.replace(/["'\\]/g, "");
    if (RM_WORD.test(s)) return "rm";
    if (HOST_WORD.test(s)) return "host";
    if (SHELL_WORD.test(s) && DASH_C_ARG.test(s)) return "nested-shell";
    if (ENV_WORD.test(s) && ENV_SPLIT_ARG.test(s)) return "env-split";
    if (env["LOKI_E10_STAGE"] && s.includes("stash") && GIT_WORD.test(s)) return "git-stash"; // STASH-GUARD: an engine session never runs `git stash` (the script's git_stash rule decides; a command that only names it is allowed)
  }
  return null;
}

function realpathOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

const within = (p: string, base: string): boolean => p === base || p.startsWith(base + sep);

/** The session's own scratch directory ($LOKI_SCRATCH), by realpath, or null when it must be ignored: it must be absolute,
 *  an existing directory, not `/`, not the home directory and not the workspace or an ancestor of it (a scratch that held the
 *  workspace would open every directory above it). The script applies the same rules (cwd block of validate-bash.sh). */
export function validScratch(scratch: string | undefined, root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!scratch || !isAbsolute(scratch)) return null;
  const real = realpathOrNull(scratch);
  if (real === null) return null;
  try { if (!statSync(real).isDirectory()) return null; } catch { return null; }
  const home = realpathOrNull(env["HOME"] || homedir());
  if (real === sep || real === home || within(root, real)) return null;
  return real;
}

// RECOVERY: a call whose cwd is outside the workspace and the scratch may still begin with `cd <absolute path>` into one of them
// (one unquoted or quoted word with no expansion, then `&&`, `;`, a newline or the end). The rest of the command goes through every other rule.
const RECOVERY_CD = /^[ \t\n]*cd[ \t]+(?:--[ \t]+)?(?:"([^"$`\\\n]+)"|'([^'\n]+)'|([^\s;&|()<>$`\\'"*?[\]~{}]+))[ \t]*(?:&&|;|\n|$)/;
export function recoveryCd(command: string, roots: string[]): boolean {
  const m = RECOVERY_CD.exec(command);
  const target = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  if (!target || !isAbsolute(target)) return false;
  const real = realpathOrNull(target);
  if (real === null) return false;
  try { if (!statSync(real).isDirectory()) return false; } catch { return false; }
  return roots.some((r) => within(real, r));
}

export const cwdRefusal = (root: string): Decision =>
  hostGuardDecision(`LOKI_HOST_GUARD: Bash command cwd is outside the assigned workspace. Run \`cd ${root}\` first.`);

// Python json.dumps (ensure_ascii) of the command as `echo` prints it, the script's audit-line encoding.
function pyJson(s: string): string {
  return JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function appendAudit(cwd: string, command: string): void {
  try {
    const dir = join(cwd, ".loki", "logs");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    appendFileSync(join(dir, "bash-audit.jsonl"), `{"timestamp":"${ts}","command":${pyJson(`${command.replace(/\n+$/, "")}\n`)}}\n`);
  } catch { /* the script ignores a failed audit write too */ }
}

/** Runs validate-bash.sh on one hook input; fails closed on a timeout, a crash or a verdict it cannot read. */
export async function runHostGuardScript(input: unknown, cwd: string, compiled: boolean, scratch?: string): Promise<Decision | Record<string, never>> {
  try {
    const senv: NodeJS.ProcessEnv = { ...process.env, LOKI_HOST_GUARD: "1", LOKI_TARGET_DIR: cwd };
    if (scratch) senv["LOKI_SCRATCH"] = scratch; else delete senv["LOKI_SCRATCH"]; // the script sees the scratch this session was given, never a stray value
    const proc = Bun.spawn({
      cmd: ["bash", HOST_GUARD_SCRIPT],
      cwd,
      env: envWithPwd(senv, cwd),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(9); }, hookTimeoutSeconds() * 1000);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    let stdout: string;
    let exitCode: number;
    try {
      [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) return hostGuardDecision("LOKI_HOST_GUARD: hook timed out, so the Bash command was denied.");
    // Compiled permission policy: an allowed command gets no decision (the script exits 0 silently), so the compiled allow/deny list decides.
    if (compiled && exitCode === 0 && stdout.trim() === "") return {};
    const parsed = JSON.parse(stdout) as Decision;
    const decision = parsed.hookSpecificOutput?.permissionDecision;
    if (exitCode === 0 && decision === "allow") return parsed;
    if (exitCode !== 0 && decision === "deny") return parsed;
    return hostGuardDecision("LOKI_HOST_GUARD: invalid hook verdict was denied.");
  } catch {
    return hostGuardDecision("LOKI_HOST_GUARD: hook execution failed, so the Bash command was denied.");
  }
}

/**
 * The PreToolUse callback for one session in `cwd` (the assigned workspace). Same verdicts as the script, which
 * runs only for a command scriptRuleMayApply names; `onScript` (tests, telemetry) learns each time it does.
 */
export function createHostGuardHook(cwd: string, env: NodeJS.ProcessEnv = process.env, onScript?: (rule: string) => void, scratch?: string): (input: unknown) => Promise<Decision | Record<string, never>> {
  const compiled = permissionPolicyMode(env, () => {}) === "compiled";
  const root = realpathOrNull(cwd);
  return async (input: unknown) => {
    const data = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : null;
    const toolInput = data?.["tool_input"];
    const raw = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>)["command"] : undefined;
    if (typeof raw !== "string" || PY_BLANK.test(raw)) return hostGuardDecision("LOKI_HOST_GUARD: malformed or missing Bash command input was denied.");
    const command = raw.replace(CONTINUATION, "$1");
    const inputCwd = typeof data?.["cwd"] === "string" ? (data["cwd"] as string) : "";
    if (!inputCwd) return cwdRefusal(root ?? cwd);
    const real = isAbsolute(inputCwd) ? realpathOrNull(inputCwd) : null;
    const scratchReal = root === null ? null : validScratch(scratch, root, env);
    const rule = root === null || real === null ? "cwd" : scriptRuleMayApply(command, env);
    if (rule !== null) { onScript?.(rule); return runHostGuardScript(input, cwd, compiled, scratchReal ?? undefined); }
    const roots = scratchReal === null ? [root!] : [root!, scratchReal];
    if (!roots.some((r) => within(real!, r)) && !recoveryCd(command, roots)) return cwdRefusal(root!);
    appendAudit(inputCwd, command);
    return compiled ? {} : ALLOW;
  };
}

/**
 * E1: the PreToolUse callback for Edit, Write and MultiEdit in an engine10 session. Always denies .loki/ (run state); in an implement or fix session also denies a write to test, build, lint or type config
 * or a lockfile the task does not name (LOKI_E10_FENCE_TASK) or a spec conflict allowlisted (LOKI_E10_FENCE_ALLOW). New test files and product
 * files are never fenced. Bash and any other writer are covered by the restore after the session (engine10/session.ts), not by reading commands.
 */
export function createConfigFenceHook(cwd: string, env: NodeJS.ProcessEnv = process.env): (input: unknown) => Promise<Decision | Record<string, never>> {
  let allowed: string[] = [];
  try { const a = JSON.parse(env["LOKI_E10_FENCE_ALLOW"] ?? "[]") as unknown; if (Array.isArray(a)) allowed = a.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
  const wrote = new Set<string>(); // new test-dir config files this session wrote: editable again in the same session
  const allow = allowFor(env["LOKI_E10_FENCE_TASK"] ?? "", allowed), outputs = harnessOutputs(cwd, env); // HARNESS-OUTPUTS: the exact .loki/ files this stage's brief names
  return async (input: unknown) => {
    const d = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const ti = d["tool_input"] !== null && typeof d["tool_input"] === "object" ? (d["tool_input"] as Record<string, unknown>) : {};
    if (!env["LOKI_E10_STAGE"]) return {};
    const hit = fenceDenied(String(d["tool_name"] ?? ""), ti["file_path"], cwd, fenceEnabled(env["LOKI_E10_STAGE"], env) ? (rel) => allow(rel) || wrote.has(rel) : () => true, true, (rel) => wrote.add(rel), outputs); // .loki/ (the harness's run state) is denied in every engine10 stage except the files its brief names; the config fence only when it is on
    if (!hit) return {};
    if (env["LOKI_E10_FENCE_DENYLOG"] && !hit.rel.startsWith(".loki")) appendDenial(env["LOKI_E10_FENCE_DENYLOG"], hit.rel, env["LOKI_ITERATION"] ?? ""); // the receipt must show a skipped config edit; the runner merges this private log
    return hostGuardDecision(hit.reason);
  };
}
