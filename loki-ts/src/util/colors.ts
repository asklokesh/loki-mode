// ANSI color constants matching autonomy/loki:25-32 byte-for-byte.
// Used by parity tests to normalize output across bash/bun routes.
export const RED = "\x1b[0;31m";
export const GREEN = "\x1b[0;32m";
export const YELLOW = "\x1b[1;33m";
export const BLUE = "\x1b[0;34m";
export const CYAN = "\x1b[0;36m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const NC = "\x1b[0m";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
