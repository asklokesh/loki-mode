// `loki crash` - inspect and manually submit local crash reports (Crash
// Reporting Phase 0, local-only, ZERO network egress).
//
// Phase 0 writes scrubbed, whitelist-only crash artifacts to .loki/crash/
// (see autonomy/lib/crash_capture.py + crash_redact.py and the runner hook in
// src/runner/crash.ts). This command lets the user self-inspect EXACTLY what
// would be sent and, with `submit`, prints a prefilled GitHub issue URL for
// manual submission. Nothing is sent automatically in this version.
//
// Subcommands:
//   loki crash                  -- list .loki/crash/*.json reports
//   loki crash show <id>        -- pretty-print one scrubbed report
//   loki crash submit [<id>]    -- print the scrubbed payload + a prefilled
//                                  github.com/asklokesh/loki-mode issue URL
//
// Parity note: the bash cmd_crash (autonomy/loki) did not yet exist when this
// port was written, so the user-facing strings here are the de-facto Phase 0
// spec. The bash author matches THIS output. See the report flag in
// docs/CRASH-REPORTING-PLAN.md Phase 0.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { BOLD, CYAN, GREEN, NC, RED, YELLOW } from "../util/colors.ts";

const ISSUE_BASE = "https://github.com/asklokesh/loki-mode/issues/new";

const HELP = `${BOLD}loki crash${NC} - inspect and manually submit local crash reports

Usage: loki crash [subcommand] [args]

Subcommands:
  (none) | list        List crash reports in .loki/crash/
  show <id>            Pretty-print one scrubbed crash report
  submit [<id>]        Print the scrubbed payload and a prefilled GitHub
                       issue URL for manual submission

Crash reports are anonymous, scrubbed, and stored locally only. Nothing is
sent automatically in this version. See docs/PRIVACY.md.
`;

type CrashReport = Record<string, unknown>;

function str(v: unknown): string {
  return v === undefined || v === null ? "-" : String(v);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function crashDir(): string {
  return join(lokiDir(), "crash");
}

// List the .json report filenames (without the .json suffix as the id), sorted.
function reportIds(): string[] {
  const dir = crashDir();
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

// Reject any id that could escape crashDir() via path traversal. A crash report
// id is a bare filename component (a filename id or a fingerprint), so it must
// never contain a path separator, a parent-dir token, or a leading separator.
// Without this, `crash show ../../../pwn` would read and print an arbitrary
// unredacted .json, falsifying the scrubbed/whitelist-only contract.
function isSafeId(id: string): boolean {
  if (id.length === 0) {
    return false;
  }
  if (id.includes("/") || id.includes("\\")) {
    return false;
  }
  if (id.includes("..")) {
    return false;
  }
  return true;
}

function readReport(id: string): CrashReport | null {
  if (!isSafeId(id)) {
    return null;
  }
  const p = join(crashDir(), `${id}.json`);
  if (!existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CrashReport;
  } catch {
    return {};
  }
}

function listCrashes(): number {
  const ids = reportIds();
  if (ids.length === 0) {
    process.stdout.write(
      `${YELLOW}No crash reports found.${NC} Nothing has been captured in .loki/crash/.\n`,
    );
    return 0;
  }
  process.stdout.write(
    `${pad("ID", 40)}  ${pad("CAPTURED_AT", 22)}  ERROR_CLASS\n`,
  );
  for (const id of ids) {
    const d = readReport(id) ?? {};
    const fp = str(d["fingerprint"]);
    const capturedAt = str(d["captured_at"]);
    const errorClass = str(d["error_class"]);
    // Prefer the fingerprint as the visible id when present; fall back to the
    // filename id so a malformed report still lists.
    const visibleId = fp !== "-" ? fp : id;
    process.stdout.write(
      `${pad(visibleId, 40)}  ${pad(capturedAt, 22)}  ${errorClass}\n`,
    );
  }
  process.stdout.write(
    `\n${ids.length} report(s). Run 'loki crash show <id>' to inspect, ` +
      `'loki crash submit' to get a prefilled GitHub issue URL.\n`,
  );
  return 0;
}

// Resolve an id argument to a report. Accepts the filename id OR the fingerprint
// stored inside the report. Returns the resolved [id, report] or null.
function resolveReport(arg: string): { id: string; report: CrashReport } | null {
  const direct = readReport(arg);
  if (direct !== null) {
    return { id: arg, report: direct };
  }
  for (const id of reportIds()) {
    const r = readReport(id);
    if (r && String(r["fingerprint"] ?? "") === arg) {
      return { id, report: r };
    }
  }
  return null;
}

function showCrash(id: string | undefined): number {
  if (!id) {
    process.stderr.write(`${RED}Missing crash id.${NC} Use 'loki crash' to list reports.\n`);
    return 2;
  }
  const resolved = resolveReport(id);
  if (resolved === null) {
    process.stderr.write(`${RED}Crash report not found: ${id}${NC}\n`);
    process.stderr.write("Use 'loki crash' to see available reports.\n");
    return 1;
  }
  process.stdout.write(`${JSON.stringify(resolved.report, null, 2)}\n`);
  return 0;
}

// Build a prefilled GitHub issue URL from the scrubbed report. Title carries the
// error class + short fingerprint; body carries the JSON payload in a code
// fence. All values are URL-encoded.
function issueUrl(report: CrashReport): string {
  const errorClass = str(report["error_class"]);
  const fp = str(report["fingerprint"]);
  const shortFp = fp !== "-" ? fp.slice(0, 12) : "unknown";
  const title = `crash: ${errorClass} (${shortFp})`;
  const payload = JSON.stringify(report, null, 2);
  const body = [
    "Anonymous crash report captured by Loki Mode (scrubbed, whitelist-only).",
    "",
    "Scrubbed payload:",
    "```json",
    payload,
    "```",
    "",
    "Nothing was sent automatically. This issue is submitted manually by me.",
  ].join("\n");
  const params = new URLSearchParams({ title, body });
  return `${ISSUE_BASE}?${params.toString()}`;
}

function submitCrash(id: string | undefined): number {
  let target: { id: string; report: CrashReport } | null;
  if (id) {
    target = resolveReport(id);
    if (target === null) {
      process.stderr.write(`${RED}Crash report not found: ${id}${NC}\n`);
      process.stderr.write("Use 'loki crash' to see available reports.\n");
      return 1;
    }
  } else {
    const ids = reportIds();
    if (ids.length === 0) {
      process.stdout.write(
        `${YELLOW}No crash reports found.${NC} Nothing to submit.\n`,
      );
      return 0;
    }
    // Default to the most recent report (filenames sort lexically and embed a
    // timestamp suffix, so the last entry is the newest).
    const lastId = ids[ids.length - 1]!;
    const report = readReport(lastId) ?? {};
    target = { id: lastId, report };
  }

  process.stdout.write(`${BOLD}Scrubbed payload (this is the ENTIRE report):${NC}\n`);
  process.stdout.write(`${JSON.stringify(target.report, null, 2)}\n\n`);
  process.stdout.write(
    `${YELLOW}Nothing is sent automatically in this version.${NC} ` +
      `Loki Mode never transmits crash data on its own.\n`,
  );
  process.stdout.write(
    `To submit manually, open this prefilled GitHub issue and review it first:\n\n`,
  );
  process.stdout.write(`  ${CYAN}${issueUrl(target.report)}${NC}\n\n`);
  process.stdout.write(`${GREEN}The payload above is exactly what the URL contains.${NC}\n`);
  process.stdout.write(`See docs/PRIVACY.md for what is and is not collected.\n`);
  return 0;
}

export async function runCrash(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case undefined:
    case "list":
      return listCrashes();
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "show":
      return showCrash(argv[1]);
    case "submit":
      return submitCrash(argv[1]);
    default:
      process.stderr.write(`${RED}Unknown crash subcommand: ${sub}${NC}\n`);
      process.stdout.write(HELP);
      return 2;
  }
}
