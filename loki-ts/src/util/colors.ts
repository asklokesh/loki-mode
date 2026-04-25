// ANSI color constants matching autonomy/loki:25-32 byte-for-byte.
// Used by parity tests to normalize output across bash/bun routes.
//
// v7.4.3 fix (BUG-15): honor the NO_COLOR convention (https://no-color.org).
// When NO_COLOR is set in the env (any non-empty value), all constants
// resolve to empty strings so output stays plain text. Bash autonomy/loki
// always emits ANSI escapes; this is one of two intentional deviations from
// strict bash parity (the other is dist-vs-source path resolution).
const NO_COLOR = (process.env["NO_COLOR"] ?? "").length > 0;

function color(code: string): string {
  return NO_COLOR ? "" : code;
}

export const RED = color("\x1b[0;31m");
export const GREEN = color("\x1b[0;32m");
export const YELLOW = color("\x1b[1;33m");
export const BLUE = color("\x1b[0;34m");
export const CYAN = color("\x1b[0;36m");
export const BOLD = color("\x1b[1m");
export const DIM = color("\x1b[2m");
export const NC = color("\x1b[0m");

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
