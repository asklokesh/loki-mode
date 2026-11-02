import * as format from "./format";

export interface Formatter { name: string; fn: (value: number) => string; example: [number, string] }

/** Every formatter the app can offer in its settings screen, with one worked example each. */
export const FORMATTERS: Formatter[] = [
  { name: "formatBytes", fn: format.formatBytes, example: [1536, "1.5 KB"] },
  { name: "formatPercent", fn: format.formatPercent, example: [0.256, "25.6%"] },
  { name: "formatDuration", fn: format.formatDuration, example: [3723, "1h 02m 03s"] },
];

export function formatterNamed(name: string): Formatter | undefined {
  return FORMATTERS.find((f) => f.name === name);
}
