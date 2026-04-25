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
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (timer) clearTimeout(timer);

  return { stdout, stderr, exitCode };
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
