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

import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
import { envWithPwd } from "./worker_proc.ts";
import { permissionPolicyMode } from "../providers/claude_flags.ts";

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
  }
  return null;
}

function realpathOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

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
export async function runHostGuardScript(input: unknown, cwd: string, compiled: boolean): Promise<Decision | Record<string, never>> {
  try {
    const proc = Bun.spawn({
      cmd: ["bash", HOST_GUARD_SCRIPT],
      cwd,
      env: envWithPwd({ ...process.env, LOKI_HOST_GUARD: "1", LOKI_TARGET_DIR: cwd }, cwd),
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
export function createHostGuardHook(cwd: string, env: NodeJS.ProcessEnv = process.env, onScript?: (rule: string) => void): (input: unknown) => Promise<Decision | Record<string, never>> {
  const compiled = permissionPolicyMode(env, () => {}) === "compiled";
  const root = realpathOrNull(cwd);
  return async (input: unknown) => {
    const data = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : null;
    const toolInput = data?.["tool_input"];
    const raw = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>)["command"] : undefined;
    if (typeof raw !== "string" || PY_BLANK.test(raw)) return hostGuardDecision("LOKI_HOST_GUARD: malformed or missing Bash command input was denied.");
    const command = raw.replace(CONTINUATION, "$1");
    const inputCwd = typeof data?.["cwd"] === "string" ? (data["cwd"] as string) : "";
    if (!inputCwd) return hostGuardDecision("LOKI_HOST_GUARD: Bash command cwd is outside the assigned workspace.");
    const real = isAbsolute(inputCwd) ? realpathOrNull(inputCwd) : null;
    const rule = root === null || real === null ? "cwd" : scriptRuleMayApply(command, env);
    if (rule !== null) { onScript?.(rule); return runHostGuardScript(input, cwd, compiled); }
    if (real !== root && !real!.startsWith(root + sep)) return hostGuardDecision("LOKI_HOST_GUARD: Bash command cwd is outside the assigned workspace.");
    appendAudit(inputCwd, command);
    return compiled ? {} : ALLOW;
  };
}
