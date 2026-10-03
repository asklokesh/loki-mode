/** The one USD formatter for the control plane UI: 2 decimals, 3 below one cent. Callers keep their own "not measured" text for null; this never prints a fake $0.00. */
export function fmtUsd(n: number): string {
  const a = Math.abs(n);
  return `$${a === 0 ? "0.000" : a < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
}
