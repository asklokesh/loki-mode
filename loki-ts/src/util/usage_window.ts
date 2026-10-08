// Pure model of a subscription usage window and a parser for the reset text
// printed by `claude -p /usage`. No spawn, no network, no file reads.

export interface UsageWindow {
  kind: "session" | "week";
  used_pct: number;
  /** Epoch seconds, or null when the reset text was absent or unparseable. */
  resets_at: number | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const RESET_RE =
  /^(?:resets\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,|\s+at|\s+@)?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?\s*$/i;

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Offset (ms) of tz from UTC at the given instant.
function offsetMs(tz: string, ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ms));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wall-clock fields in tz to epoch ms. A nonexistent time (spring forward)
// resolves forward by the gap; an ambiguous time (fall back) resolves to the
// first occurrence.
function wallToEpochMs(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo, d, h, mi, 0);
  const before = offsetMs(tz, naive - 86400_000);
  const after = offsetMs(tz, naive + 86400_000);
  const valid = [before, after]
    .map((o) => naive - o)
    .filter((t) => offsetMs(tz, t) === naive - t);
  if (valid.length > 0) return Math.min(...valid);
  return naive - before; // nonexistent time: use the pre-gap offset
}

function yearIn(tz: string, ms: number): number {
  return new Date(ms + offsetMs(tz, ms)).getUTCFullYear();
}

/**
 * Parse reset text such as "Oct 1 at 3:20am (America/New_York)", "Oct 7 at 1pm"
 * or "4am" into epoch seconds. A zone in parentheses wins over `tz`. Text with
 * no date resolves to the next occurrence after `now`; text with a date and no
 * year resolves to the first such date at or after `now`. Returns null when
 * the text or zone cannot be understood; it never invents a time.
 */
export function parseResetText(s: string, now: number, tz: string): number | null {
  if (typeof s !== "string" || !Number.isFinite(now)) return null;
  const m = RESET_RE.exec(s.trim());
  if (!m) return null;
  const zone = (m[6] ?? tz ?? "").trim();
  if (!zone || !validZone(zone)) return null;

  let hour = Number(m[3]);
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = m[5]!.toLowerCase() === "pm";
  hour = (hour % 12) + (pm ? 12 : 0);

  const nowMs = now * 1000;
  const local = new Date(nowMs + offsetMs(zone, nowMs));

  if (m[1] === undefined) {
    const y = local.getUTCFullYear();
    const mo = local.getUTCMonth();
    const d = local.getUTCDate();
    let t = wallToEpochMs(zone, y, mo, d, hour, minute);
    if (t <= nowMs) t = wallToEpochMs(zone, y, mo, d + 1, hour, minute);
    return Math.floor(t / 1000);
  }

  const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]);
  if (mon < 0 || day < 1 || day > 31) return null;
  const y0 = yearIn(zone, nowMs);
  for (const y of [y0, y0 + 1, y0 + 2]) {
    if (new Date(Date.UTC(y, mon, day)).getUTCMonth() !== mon) continue; // e.g. Feb 30
    const t = wallToEpochMs(zone, y, mon, day, hour, minute);
    if (t >= nowMs) return Math.floor(t / 1000);
    if (y === y0 + 1) break;
  }
  return null;
}
