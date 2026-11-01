/** 5-field cron schedules with Quartz-style day specials, evaluated in UTC. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
}

type DomSpecial = { kind: "L" } | { kind: "LW" } | { kind: "W"; n: number };
type DowSpecial = { kind: "last"; d: number } | { kind: "nth"; d: number; k: number };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const SPECS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS },
  { min: 0, max: 7, names: DAYS },
];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseValue(text: string, spec: FieldSpec, expr: string): number {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n < spec.min || n > spec.max) throw new CronError(`value out of range in "${expr}"`);
    return n;
  }
  if (spec.names) {
    const idx = spec.names.indexOf(text.toUpperCase());
    if (idx >= 0) return spec.names === MONTHS ? idx + 1 : idx;
  }
  throw new CronError(`bad value "${text}" in "${expr}"`);
}

function parseItem(item: string, spec: FieldSpec, expr: string, out: Set<number>): void {
  let range = item;
  let step = 1;
  const slash = item.indexOf("/");
  if (slash >= 0) {
    range = item.slice(0, slash);
    const stepText = item.slice(slash + 1);
    if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`bad step in "${expr}"`);
    step = Number(stepText);
    if (range !== "*" && !range.includes("-")) throw new CronError(`step needs * or a range in "${expr}"`);
  }
  let lo: number;
  let hi: number;
  if (range === "*") {
    lo = spec.min;
    hi = spec.max;
  } else if (range.includes("-")) {
    const parts = range.split("-");
    if (parts.length !== 2) throw new CronError(`bad range in "${expr}"`);
    lo = parseValue(parts[0], spec, expr);
    hi = parseValue(parts[1], spec, expr);
    if (lo > hi) throw new CronError(`reversed range in "${expr}"`);
  } else {
    lo = hi = parseValue(range, spec, expr);
  }
  for (let v = lo; v <= hi; v += step) out.add(v);
}

function parseField(text: string, spec: FieldSpec, expr: string): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) parseItem(item, spec, expr, out);
  return out;
}

function parseDom(text: string, expr: string): { values: Set<number>; specials: DomSpecial[] } {
  const values = new Set<number>();
  const specials: DomSpecial[] = [];
  for (const item of text.split(",")) {
    const up = item.toUpperCase();
    const w = /^(\d+)W$/.exec(up);
    if (up === "L") specials.push({ kind: "L" });
    else if (up === "LW") specials.push({ kind: "LW" });
    else if (w) specials.push({ kind: "W", n: parseValue(w[1], SPECS[2], expr) });
    else parseItem(item, SPECS[2], expr, values);
  }
  return { values, specials };
}

function parseDow(text: string, expr: string): { values: Set<number>; specials: DowSpecial[] } {
  const values = new Set<number>();
  const specials: DowSpecial[] = [];
  for (const item of text.split(",")) {
    const last = /^(.+)L$/i.exec(item);
    const nth = /^(.+)#(.*)$/.exec(item);
    if (last) {
      specials.push({ kind: "last", d: parseValue(last[1], SPECS[4], expr) % 7 });
    } else if (nth) {
      if (!/^[1-5]$/.test(nth[2])) throw new CronError(`bad # occurrence in "${expr}"`);
      specials.push({ kind: "nth", d: parseValue(nth[1], SPECS[4], expr) % 7, k: Number(nth[2]) });
    } else {
      parseItem(item, SPECS[4], expr, values);
    }
  }
  if (values.has(7)) values.add(0);
  return { values, specials };
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m, d)).getUTCDay();
}

function nearestWeekday(y: number, m: number, n: number, last: number): number {
  const wd = weekday(y, m, n);
  if (wd === 6) return n === 1 ? 3 : n - 1;
  if (wd === 0) return n === last ? n - 2 : n + 1;
  return n;
}

function lastWeekday(y: number, m: number, last: number): number {
  const wd = weekday(y, m, last);
  return wd === 6 ? last - 1 : wd === 0 ? last - 2 : last;
}

/** The first minute strictly after `from` that matches `expr`. */
export function nextRun(expr: string, from: Date): Date {
  let text = expr.trim();
  if (text.startsWith("@")) {
    const alias = ALIASES[text.toLowerCase()];
    if (!alias) throw new CronError(`unknown alias "${expr}"`);
    text = alias;
  }
  const fields = text.split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") throw new CronError(`expected 5 fields in "${expr}"`);
  const minutes = parseField(fields[0], SPECS[0], expr);
  const hours = parseField(fields[1], SPECS[1], expr);
  const dom = parseDom(fields[2], expr);
  const months = parseField(fields[3], SPECS[3], expr);
  const dow = parseDow(fields[4], expr);
  const domStar = fields[2] === "*";
  const dowStar = fields[4] === "*";

  const domMatches = (y: number, m: number, d: number): boolean => {
    if (dom.values.has(d)) return true;
    const last = daysIn(y, m);
    return dom.specials.some((s) => {
      if (s.kind === "L") return d === last;
      if (s.kind === "LW") return d === lastWeekday(y, m, last);
      return s.n <= last && d === nearestWeekday(y, m, s.n, last);
    });
  };
  const dowMatches = (y: number, m: number, d: number): boolean => {
    const wd = weekday(y, m, d);
    if (dow.values.has(wd)) return true;
    return dow.specials.some((s) => {
      if (wd !== s.d) return false;
      if (s.kind === "last") return d + 7 > daysIn(y, m);
      return Math.ceil(d / 7) === s.k;
    });
  };

  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const limit = new Date(start.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 5);

  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let first = true;
  while (day.getTime() < limit.getTime()) {
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth();
    const d = day.getUTCDate();
    if (!months.has(mo + 1)) {
      // Skip the whole month: jump to the 1st of the next one.
      day.setUTCMonth(mo + 1, 1);
      first = false;
      continue;
    }
    const domOk = domMatches(y, mo, d);
    const dowOk = dowMatches(y, mo, d);
    const dayOk = !domStar && !dowStar ? domOk || dowOk : domOk && dowOk;
    if (dayOk) {
      for (let h = first ? start.getUTCHours() : 0; h < 24; h++) {
        if (!hours.has(h)) continue;
        const m0 = first && h === start.getUTCHours() ? start.getUTCMinutes() : 0;
        for (let m = m0; m < 60; m++) {
          if (!minutes.has(m)) continue;
          const hit = new Date(day.getTime() + (h * 60 + m) * 60000);
          if (hit.getTime() >= limit.getTime()) throw new CronError(`no run within 5 years for "${expr}"`);
          return hit;
        }
      }
    }
    first = false;
    day.setUTCDate(day.getUTCDate() + 1);
  }
  throw new CronError(`no run within 5 years for "${expr}"`);
}
