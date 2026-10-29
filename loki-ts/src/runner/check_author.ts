// Walled check author for the Bun runner (moat P3, TS twin of
// checklist_author / checklist_freeze_once in autonomy/prd-checklist.sh).
//
// The agent that writes the code never writes the acceptance checks. Before the
// main loop this authors them in a separate provider call that runs in an EMPTY
// run-owned directory (the repo is never the cwd and never named in the prompt),
// validates the reply with autonomy/lib/check_author.py `accept`, and freezes
// the result. Once per spec sha256, at most 2 attempts. A failed author leaves
// the critical failing sentinel (written by `accept` itself) and freeze refuses
// any checklist.json the implementer writes afterwards.
//
// All validation, schema, sentinel and prompt logic lives in check_author.py and
// checklist-verify.py and is reached through their CLIs; nothing is re-derived
// here. The digest of the accepted checklist is held in this module's memory
// only (never exported, never written to a file), because author.json is an
// unsigned file the implementer can forge.
//
// New file justification: the Bun runner had no checklist module; the bash
// owner of this concern (prd-checklist.sh) cannot be sourced from Bun.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
import { run as shellRun } from "../util/shell.ts";
import { textOnlyArgv } from "./providers.ts";
import type { ProviderInvoker, RunnerContext } from "./types.ts";

export const CHECK_AUTHOR_MAX_ATTEMPTS = 2;

// Harness memory only. See the header: never persisted, never exported.
let authoredDigest = "";
let frozenDigest = "";

// Test seam: simulate a fresh process (a restart forgets the in-memory digest).
export function resetCheckAuthorMemory(): void {
  authoredDigest = "";
  frozenDigest = "";
}

export function checklistFrozenDigest(): string {
  return frozenDigest;
}

function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

// Same resolution order as _loki_snapshot_py_tool in autonomy/run.sh: a system
// interpreter first, then absolute PATH entries, each probed with -I -S.
async function snapshotPython(): Promise<string | null> {
  const cands = ["/usr/bin/python3", "/bin/python3"];
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir.startsWith("/")) cands.push(join(dir, "python3"));
  }
  for (const c of cands) {
    if (!existsSync(c)) continue;
    const r = await shellRun([c, "-I", "-S", "-c", ""]).catch(() => null);
    if (r !== null && r.exitCode === 0) return c;
  }
  return null;
}

// Field of the author record, "" when absent, unreadable or a symlink (same as
// _checklist_author_field: a symlinked record is not trusted).
function authorField(checklistDir: string, field: string): string {
  const rec = join(checklistDir, "author.json");
  try {
    if (lstatSync(rec).isSymbolicLink()) return "";
    const v = (JSON.parse(readFileSync(rec, "utf8")) as Record<string, unknown>)[field];
    return v === undefined || v === null ? "" : String(v);
  } catch {
    return "";
  }
}

async function acceptCall(
  py: string,
  script: string,
  stdinText: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: [py, "-I", "-S", script, "accept", ...args],
      stdin: new Blob([stdinText]),
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

// Freeze the check definitions once, fail closed. Refuses unless the checks were
// authored by the check author for THIS spec and checklist.json still matches
// the digest the harness recorded in memory when it accepted the reply.
export async function checklistFreezeOnce(ctx: RunnerContext): Promise<boolean> {
  if (frozenDigest !== "") return true;
  const dir = join(ctx.lokiDir, "checklist");
  const file = join(dir, "checklist.json");
  if (!existsSync(file) || ctx.prdPath === undefined) return false;
  const prd = isAbsolute(ctx.prdPath) ? ctx.prdPath : resolve(ctx.cwd, ctx.prdPath);
  const status = authorField(dir, "status");
  const sha = authorField(dir, "spec_sha256");
  const want = sha256File(prd);
  if (status !== "authored" || sha === "" || sha !== want) {
    ctx.log(`[check-author] freeze refused: the checks were not authored by the check author (status: ${status || "none"})`);
    return false;
  }
  if (authoredDigest === "" || sha256File(file) !== authoredDigest) {
    ctx.log("[check-author] freeze refused: checklist.json does not match the checklist the check author produced");
    return false;
  }
  const py = await snapshotPython();
  const verify = join(REPO_ROOT, "autonomy", "checklist-verify.py");
  if (py === null || !existsSync(verify)) return false;
  const r = await shellRun([py, "-I", "-S", verify, "--checklist", file, "--freeze"]).catch(() => null);
  const digest = r === null || r.exitCode !== 0 ? "" : r.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;
  frozenDigest = digest;
  return true;
}

export function checkAuthorEnabled(ctx: RunnerContext, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env["LOKI_CHECKLIST_ENABLED"] ?? "true") !== "true") return false;
  if ((env["LOKI_CHECKLIST_AUTHOR"] ?? "1") === "0") return false;
  if (ctx.prdPath === undefined || ctx.prdPath === "") return false;
  const prd = isAbsolute(ctx.prdPath) ? ctx.prdPath : resolve(ctx.cwd, ctx.prdPath);
  return existsSync(prd);
}

// Author the acceptance checks. Returns true when a checklist was authored and
// frozen. Never throws: every failure is fail closed (sentinel written by
// `accept`, completion stays blocked) and the run continues, as in bash.
export async function runCheckAuthor(ctx: RunnerContext, provider: ProviderInvoker): Promise<boolean> {
  if (!checkAuthorEnabled(ctx)) return true;
  const prd = isAbsolute(ctx.prdPath as string) ? (ctx.prdPath as string) : resolve(ctx.cwd, ctx.prdPath as string);
  const dir = join(ctx.lokiDir, "checklist");
  const script = join(REPO_ROOT, "autonomy", "lib", "check_author.py");
  mkdirSync(dir, { recursive: true });
  const py = await snapshotPython();
  if (py === null || !existsSync(script)) {
    ctx.log("[check-author] unavailable (fail closed): freeze refuses until the checks are authored");
    return false;
  }
  const specSha = sha256File(prd);
  const priorStatus = authorField(dir, "status");
  const priorSha = authorField(dir, "spec_sha256");
  let attempts = 0;
  if (specSha !== "" && priorSha === specSha) {
    // An authored record is only trusted by the process that wrote it: the
    // accepted digest lives in memory, so a restarted process re-authors (within
    // the attempt cap) rather than believe an unsigned author.json.
    if (priorStatus === "authored" && authoredDigest !== "") {
      await checklistFreezeOnce(ctx);
      return true;
    }
    const n = Number(authorField(dir, "attempts"));
    attempts = Number.isInteger(n) && n >= 0 ? n : 0;
  }

  const base = process.env["LOKI_RUN_TMP"] !== undefined && process.env["LOKI_RUN_TMP"] !== "" ? process.env["LOKI_RUN_TMP"] : tmpdir();
  const work = mkdtempSync(join(base, "loki-author."));
  try {
    const cwd = join(work, "cwd");
    mkdirSync(cwd);
    const ctxFile = join(work, "context.json");
    const acceptArgs = (n: number): string[] => [
      "--spec", prd, "--repo", ctx.cwd, "--out", dir, "--context", ctxFile, "--attempts", String(n),
    ];
    const c = await shellRun([py, "-I", "-S", script, "context", "--spec", prd, "--repo", ctx.cwd]).catch(() => null);
    let prompt = "";
    if (c !== null && c.exitCode === 0) {
      try {
        prompt = String((JSON.parse(c.stdout) as { prompt?: unknown }).prompt ?? "");
        writeFileSync(ctxFile, c.stdout);
      } catch {
        prompt = "";
      }
    }
    if (prompt === "") {
      await acceptCall(py, script, "", ["--spec", prd, "--repo", ctx.cwd, "--out", dir, "--attempts", String(CHECK_AUTHOR_MAX_ATTEMPTS)]);
      ctx.log("[check-author] could not build the author context (fail closed)");
      return false;
    }

    let ok = false;
    while (attempts < CHECK_AUTHOR_MAX_ATTEMPTS) {
      attempts += 1;
      let out = "";
      try {
        const outPath = join(work, `reply-${attempts}.txt`);
        const res = await provider.invoke({
          provider: ctx.provider,
          prompt,
          tier: "fast",
          cwd,
          iterationOutputPath: outPath,
          textOnly: true,
        });
        const cap = res.capturedOutputPath !== "" && existsSync(res.capturedOutputPath) ? res.capturedOutputPath : outPath;
        if (res.exitCode === 0 && existsSync(cap)) {
          out = readFileSync(cap, "utf8");
          // The provider writes "<stderr>\n<stdout>"; only stdout is the reply.
          const err = res.stderr ?? "";
          if (err.length > 0 && out.startsWith(`${err}\n`)) out = out.slice(err.length + 1);
        }
      } catch {
        out = "";
      }
      if (await acceptCall(py, script, out, acceptArgs(attempts))) {
        ok = true;
        break;
      }
    }
    // Labelled from the argv actually sent: no-tools only when --tools= is in it.
    const isolation = ctx.provider === "claude" && textOnlyArgv().includes("--tools=") ? "no-tools" : "cwd-only";
    ctx.log(`[check-author] isolation: ${isolation}`);
    try {
      writeFileSync(join(dir, "author-isolation.txt"), `check author isolation: ${isolation}\n`);
    } catch { /* informational */ }
    if (!ok) {
      ctx.log(`[check-author] no valid checks after ${attempts} attempt(s); completion stays blocked`);
      return false;
    }
    authoredDigest = sha256File(join(dir, "checklist.json"));
    await checklistFreezeOnce(ctx);
    return true;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
