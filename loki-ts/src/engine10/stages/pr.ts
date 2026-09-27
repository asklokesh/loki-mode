// loki-ts/src/engine10/stages/pr.ts
//
// E-11 (TS half): PR stage (docs/v10/ENGINE.md sections 4, 6, 7). Runs in the
// SUPERVISOR (P0), never the worker: this is the only stage that touches
// GitHub credentials, and it does so only through the credentialed push
// child autonomy/lib/engine10-push.sh (P4, the bash half of E-11, already on
// main). No LLM, no untrusted text is read here.
//
// Contract-gap notes (RunContext/types.ts, E-01, does not yet carry these;
// their real owners -- supervisor.ts/E-03 and machine.ts/E-02 -- are in
// rework and not on main):
//  - the pinned origin (section 6 "Origin pin") and the cap-hit signal
//    (section 4 "Hard cap") are read through the optional PrContext
//    companion shape below, the same local-extension pattern intake.ts
//    (IntakeOptions) already uses for its own contract gap;
//  - pushArgv's push-pr shape (types.ts) ends in a literal "1"/"0", but
//    engine10-push.sh's real usage accepts only 4 args plus an optional
//    literal "--draft" (`[ "$5" = "--draft" ] || die "unknown flag: $5"`).
//    This stage still builds argv with pushArgv, per the slice card, then
//    translates that trailing flag rather than editing either file.
//  - engine10-push.sh has no way to say whether push-pr created a new PR or
//    reused an open one (confirmed by tests/test-engine10-push.sh: the
//    "second call reuses the existing PR URL" case is only visible to that
//    test because it counts `gh pr create` calls out of band; the script's
//    own stdout is identical either way). Reporting `existing` as a
//    fabricated true/false would violate "unknown is never 0" (section 5),
//    so this stage reports it as null and records the gap for whoever next
//    touches the bash half to add a real signal.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushArgs, RunContext, Stage, StageResult, Verdict } from "../types.ts";
import { pushArgv } from "../types.ts";

/** RunContext plus the two values this stage needs that E-03/E-02 will
 *  eventually inject; see the contract-gap note above. */
export type PrContext = RunContext & {
  /** remote.origin.url, read once by the supervisor before any provider ran. */
  pinnedOrigin?: string;
  /** True once the global cap (machine.ts) has fired for this run. */
  capHit?(): boolean;
};

export interface PrOptions {
  /** Injectable for tests; defaults to the real script next to this checkout. */
  pushScriptPath?: string;
}

export const DEFAULT_PUSH_SH = new URL("../../../../autonomy/lib/engine10-push.sh", import.meta.url).pathname;

const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
}

function buildBody(verdict: Verdict, notProven: string[], receiptPath: string | null): string {
  const lines = [`Verdict: ${verdict}`, ""];
  if (notProven.length > 0) lines.push("NOT PROVEN:", ...notProven.map((p) => `- ${p}`));
  if (receiptPath) lines.push("", `Receipt: ${receiptPath}`);
  return `${lines.join("\n")}\n`;
}

/** pushArgv's push-pr shape ends "...,"1"|"0"". engine10-push.sh instead
 *  wants only an optional literal "--draft" (4 or 5 total args). Translate
 *  rather than edit either file (see the contract-gap note above). */
function toPushShellArgs(args: PushArgs): string[] {
  const built = pushArgv(args);
  const flag = built.pop();
  if (flag === "1") built.push("--draft");
  return built;
}

export async function runPr(ctx: PrContext, signal: AbortSignal, opts: PrOptions = {}): Promise<StageResult> {
  if (signal.aborted) return { status: "failed", data: {}, reason: "aborted before pr started" };

  const pinnedOrigin = ctx.pinnedOrigin;
  if (!pinnedOrigin) {
    return { status: "failed", data: {}, reason: "no pinned origin: refusing to push (Rule of Two)" };
  }

  const seal = (ctx.outputs().seal ?? {}) as { verdict?: Verdict; not_proven?: string[]; receipt_path?: string };
  const verdict = seal.verdict ?? "PARTIAL"; // fail-safe: an unknown verdict is never treated as VERIFIED
  const notProven = seal.not_proven ?? [];
  const capHit = ctx.capHit?.() ?? false;
  const draft = verdict !== "VERIFIED" || capHit;

  mkdirSync(ctx.runDir, { recursive: true });
  const bodyFile = join(ctx.runDir, "pr-body.md");
  writeFileSync(bodyFile, buildBody(verdict, notProven, seal.receipt_path ?? null), "utf8");

  const title = `Loki 10: ${verdict} (${ctx.runId})`;
  const pushShellArgs = toPushShellArgs({ cmd: "push-pr", repoDir: ctx.repoDir, branch: ctx.branch, title, bodyFile, draft });

  const scriptPath = opts.pushScriptPath ?? DEFAULT_PUSH_SH;
  const env = { ...process.env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: pinnedOrigin };

  const pushResult = spawnSync("bash", [scriptPath, ...pushShellArgs], { env, encoding: "utf8" });
  if (pushResult.status !== 0) {
    return {
      status: "failed",
      data: {},
      reason: `engine10-push.sh push-pr failed (exit ${pushResult.status}): ${(pushResult.stderr ?? "").trim()}`,
    };
  }
  const url = lastNonEmptyLine(pushResult.stdout ?? "");
  // E-41: for a local bare origin (the eval harness) push-pr prints exactly
  // local://<pinned origin>#<branch>; accepted only for an absolute, colon-free pin.
  const localOk = pinnedOrigin.startsWith("/") && !pinnedOrigin.includes(":") && url === `local://${pinnedOrigin}#${ctx.branch}`;
  if (!localOk && !PR_URL_RE.test(url)) {
    return { status: "failed", data: {}, reason: `engine10-push.sh push-pr printed no valid PR URL (got: ${url || "(empty)"})` };
  }

  // Unknown, not fabricated: see the contract-gap note above.
  const existing: boolean | null = null;
  ctx.emit("pr.opened", "pr", { url, draft, existing });

  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.repoDir, encoding: "utf8", env: process.env }).trim();
  const notProvenOut: string[] = [];
  if (localOk) {
    // A local bare origin (the eval harness) has no commit status API.
    notProvenOut.push("commit status loki/deep-verify not set (local origin)");
  } else if (SHA_RE.test(headSha)) {
    const statusShellArgs = pushArgv({ cmd: "status", sha: headSha, state: "pending", description: "Loki 10 deep verify pending" });
    const statusResult = spawnSync("bash", [scriptPath, ...statusShellArgs], { env, encoding: "utf8" });
    // Non-fatal: the PR is already open. A failed status call is recorded, not a red PR stage.
    if (statusResult.status !== 0) notProvenOut.push("commit status loki/deep-verify not set");
  } else {
    notProvenOut.push("commit status loki/deep-verify not set (HEAD sha not resolvable)");
  }

  return {
    status: "completed",
    data: { pr_url: url, draft, existing, ...(notProvenOut.length ? { not_proven: notProvenOut } : {}) },
  };
}

export const stage: Stage = {
  name: "pr",
  targetS: 15,
  limitS: 60,
  run: (ctx, signal) => runPr(ctx as PrContext, signal),
};
export const prStage = stage;
