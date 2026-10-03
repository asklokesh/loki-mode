// Hook points for later slices. Cmd+K (Ctrl+K) is reserved for the command palette (CPE-22): it registers a handler here.
let palette: (() => void) | null = null;

export function setCommandPaletteHandler(h: (() => void) | null): void { palette = h; }

/** Called by the shell on Cmd+K / Ctrl+K. Returns true when a handler consumed the key. */
export function openCommandPalette(): boolean {
  if (!palette) return false;
  palette();
  return true;
}
