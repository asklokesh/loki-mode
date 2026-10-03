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
