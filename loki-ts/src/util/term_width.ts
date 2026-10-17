/** Single source of terminal width (FC-10, L7). A pty with no size reports columns undefined or 0 (script -q, CI, tmux before resize, IDE terminals). */
export const MIN_TERM_WIDTH = 40;
export const DEFAULT_TERM_WIDTH = 80;

const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= MIN_TERM_WIDTH;

export function terminalWidth(
  stream: { columns?: number } | undefined = process.stdout,
  env: Record<string, string | undefined> = process.env,
): number {
  const c = stream?.columns;
  if (valid(c)) return Math.floor(c);
  const e = Number(env["COLUMNS"]);
  if (valid(e)) return Math.floor(e);
  return DEFAULT_TERM_WIDTH;
}

// Terminal display formatting shared by engine10 output and the run-summary views (moved out of engine10 core, TEN budget).
export function formatClock(elapsedS: number): string {
  const s = Math.max(0, Math.round(elapsedS));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
/** 212000 -> "212k"; under 1000 renders as-is. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  return v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`;
}
