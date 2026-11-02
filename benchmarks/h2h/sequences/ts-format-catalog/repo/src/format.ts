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
