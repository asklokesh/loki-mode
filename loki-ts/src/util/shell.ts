// Bun.$ wrapper with timeout, structured errors, exit-code propagation.
// Foundation for every command port that needs to call out to system tools
// (claude, codex, jq, git, docker, curl, etc.).
import { $ } from "bun";

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ShellOpts = {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
};

// v7.77.0 (W77-D LOW): cap how many bytes we slurp from a child's stdout.
// Children here are trusted + time-bounded, so this is a defensive ceiling
// against a runaway producer wedging the parent's heap, not a security
// boundary. 16MB is far above any real CLI output (claude/codex verdicts,
// git/docker/jq output) we parse. Output beyond the cap is truncated.
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

// Read a ReadableStream of bytes into a UTF-8 string, stopping once
// MAX_STDOUT_BYTES have been accumulated. The stream is cancelled after the
// cap so the producer is not left blocked on a full pipe. Returns the decoded
// (possibly truncated) text.
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes = MAX_STDOUT_BYTES,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Keep only the slice that fits under the cap, then stop.
        const keep = value.byteLength - (total - maxBytes);
        out += decoder.decode(value.subarray(0, keep), { stream: true });
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed -- ignore
    }
    reader.releaseLock();
  }
  return out;
}

export class ShellError extends Error {
  constructor(
    public override readonly message: string,
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "ShellError";
  }
}

// Run a command and capture stdout/stderr without throwing on non-zero exit.
// Use this when you want to inspect exit codes (like `command -v` checks).
//
// v7.5.2 fixes (bug-hunt H6):
//   - SIGTERM -> SIGKILL escalation: a subprocess that ignores SIGTERM
//     (common with python wrappers, codex/claude shells trapping signals)
//     used to deadlock the await Promise.all forever. Now SIGTERM first,
//     then SIGKILL after a 2s grace, so the timeout actually fires.
//   - Timer cleanup in finally: if `new Response(proc.stdout).text()`
//     rejected (closed stream, decode error), clearTimeout never ran
//     and the timer kept firing on a long-since-exited process. Wrapped
//     in try/finally so timers are always released.
export async function run(
  argv: readonly string[],
  opts: ShellOpts = {},
): Promise<ShellResult> {
  const proc = Bun.spawn({
    cmd: [...argv],
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    cwd: opts.cwd,
  });

  let timer: Timer | undefined;
  let killTimer: Timer | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      // SIGTERM first; if the process ignores it, SIGKILL after 2s.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 2000);
    }, opts.timeoutMs);
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      // v7.77.0 (W77-D LOW): bounded read so a runaway child cannot OOM the
      // parent. Timeout behavior above is preserved -- the cap is independent.
      readStreamCapped(proc.stdout as ReadableStream<Uint8Array>),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
}

// Strict variant: throws ShellError on non-zero exit.
export async function runOrThrow(
  argv: readonly string[],
  opts: ShellOpts = {},
): Promise<ShellResult> {
  const r = await run(argv, opts);
  if (r.exitCode !== 0) {
    throw new ShellError(
      `command failed (${r.exitCode}): ${argv.join(" ")}`,
      r.exitCode,
      r.stdout,
      r.stderr,
    );
  }
  return r;
}

// Mirror of bash `command -v <name> &>/dev/null`.
// Returns the resolved path or null on missing command. Throws on suspicious
// input (anything outside [A-Za-z0-9._/-]) to keep callers from passing user
// data into a shell.
export async function commandExists(name: string): Promise<string | null> {
  const safe = shEscape(name); // throws on injection attempt -- intentional
  // v7.4.3 (BUG-14): cap at 5s. `command -v` is fast on healthy systems but
  // can stall if /etc/profile or shell init does heavy work; without a
  // timeout doctor's dependency probes could hang the CLI.
  const r = await run(["sh", "-c", `command -v ${safe}`], { timeoutMs: 5000 });
  if (r.exitCode === 0) {
    const path = r.stdout.trim();
    return path || null;
  }
  return null;
}

// Minimal shell escape for command names (allow words, hyphens, dots).
// Reject anything else to prevent injection in commandExists.
function shEscape(name: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw new Error(`refused to shell-escape suspect token: ${name}`);
  }
  return name;
}

// Convenience: get command version via `<name> --version` (one common case).
// Returns null if command missing or version flag fails.
export async function commandVersion(
  name: string,
  flag = "--version",
): Promise<string | null> {
  const path = await commandExists(name);
  if (!path) return null;
  const r = await run([name, flag], { timeoutMs: 5000 });
  if (r.exitCode !== 0) return null;
  // Most CLIs print version on first line; some on stderr.
  const first = (r.stdout || r.stderr).split(/\r?\n/)[0]?.trim() ?? "";
  return first || null;
}
