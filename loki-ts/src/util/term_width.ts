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
/** Clips at the last word boundary within max and marks the cut with "..." (the full text stays in the receipt and HANDOFF). */
export function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 4) return s.slice(0, Math.max(0, max));
  const cut = s.slice(0, max - 3), sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "")}...`;
}
/** One summary line from a push child's stderr: the fork-only notice as is, else the script's own die line, plus gh/git's "Permission to X denied" when present. Raw multi-line stderr never reaches NOT PROVEN. */
export function pushErrLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.replace(/[\x00-\x1f\x7f]+/g, " ").trim()).filter(Boolean);
  const fork = lines.find((l) => l.startsWith("fork-only: ")); if (fork) return fork;
  const die = lines.findLast((l) => /^engine10-push(?:-gitlab)?: /.test(l)) ?? lines.at(-1) ?? "", denied = lines.find((l) => /Permission to \S+ denied to/.test(l))?.replace(/^remote:\s*/, "");
  return clipWords(denied && !die.includes(denied) ? `${die}: ${denied}` : die, 300);
}
