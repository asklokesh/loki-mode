import { assertFiniteNumber } from "./guard";

/** 1536 -> "1.5 KB". Units step by 1024; one decimal from KB up. */
export function formatBytes(bytes: number): string {
  assertFiniteNumber("bytes", bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.abs(bytes), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(v) : v.toFixed(1);
  return `${bytes < 0 ? "-" : ""}${s} ${units[i]}`;
}

/** 0.256 -> "25.6%". One decimal. */
export function formatPercent(ratio: number): string {
  assertFiniteNumber("ratio", ratio);
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDuration(seconds: number): string {
  assertFiniteNumber("seconds", seconds);
  if (seconds < 0) throw new RangeError("seconds must be non-negative");
  const t = Math.floor(seconds), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${p(m)}m ${p(s)}s`;
  if (m > 0) return `${m}m ${p(s)}s`;
  return `${s}s`;
}

export function formatOrdinal(n: number): string {
  assertFiniteNumber("n", n);
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a non-negative integer");
  const h = n % 100, t = n % 10;
  const suffix = h >= 11 && h <= 13 ? "th" : t === 1 ? "st" : t === 2 ? "nd" : t === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

export function formatCompact(n: number): string {
  assertFiniteNumber("n", n);
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  const [div, unit] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  return `${n < 0 ? "-" : ""}${(a / div).toFixed(1).replace(/\.0$/, "")}${unit}`;
}

export function formatCurrency(cents: number, symbol = "$"): string {
  assertFiniteNumber("cents", cents);
  if (!Number.isInteger(cents)) throw new RangeError("cents must be an integer");
  const a = Math.abs(cents), whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}${symbol}${whole}.${String(a % 100).padStart(2, "0")}`;
}
