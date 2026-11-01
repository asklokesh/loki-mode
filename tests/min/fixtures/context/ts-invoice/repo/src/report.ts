import { formatCents, type Cents } from "./money";

export interface ReportRow {
  label: string;
  cents: Cents;
}

export function renderReport(title: string, rows: ReportRow[]): string {
  const width = Math.max(title.length, ...rows.map((r) => r.label.length));
  const lines = rows.map((r) => `${r.label.padEnd(width)}  ${formatCents(r.cents)}`);
  return [title, "-".repeat(width), ...lines].join("\n");
}
