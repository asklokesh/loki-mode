// v8: `loki internal sdk-judge` -- the bash->raw-SDK judge bridge.
//
// A bash judge site (done-recognition, council-v2, code-review, ...) invokes this
// instead of `claude -p --json-schema` when its SDK flag is on. It reads a prompt
// file and a JSON-schema file, runs the pure-HTTPS raw-SDK judge (sdk_invoker
// judgeJson), and prints the parsed JSON object to stdout. Exit 0 + JSON on
// success; non-zero + no stdout on ANY failure so the bash caller falls back to
// its existing claude/deterministic path (fail-closed, identical to today).
//
// Usage (driven by run.sh; not user-facing):
//   loki internal sdk-judge --prompt-file P --schema-file S \
//     [--model M] [--effort low|medium|high|xhigh|max] [--max-tokens N] [--thinking disabled|adaptive] [--timeout-ms N]
//
// Exit codes: 0 ok (+ JSON on stdout); 2 bad args; 3 read error; 1 judge returned
// null (no key / transport / malformed / refusal). Only 0 prints stdout.

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { type Effort, describeJudgeOutcome, judgeJsonOutcome, judgeTextOutcome } from "../runner/sdk_invoker.ts";
import { lokiDir } from "../util/paths.ts";
import { thinkingConflictsEffort, thinkingUsageError } from "../providers/claude_flags.ts";
import { isUnresolvedClaudeAlias, resolveClaudeModel } from "../util/claude_model.ts";

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// Parse a numeric CLI arg so an EXPLICIT positive value is honored and only an
// absent/invalid/non-positive value falls back to the sdk_invoker default. A
// bare `Number(v) || undefined` treated `--timeout-ms 0` as unset (council
// review C3). Exported for a direct unit test.
export function parsePosInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// COST-WALL: the bash callers shell out here for the SDK path, which never reaches their loki_child_ledger_append; the ledger line is written here instead (optional --phase names the role).
export function cliLedger(args: string[], fallbackPhase: string): { lokiDir: string; phase: string } {
  return { lokiDir: lokiDir(), phase: argVal(args, "--phase") ?? fallbackPhase };
}

const VALID_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);

/** --thinking: `disabled` or `adaptive` only; absent is undefined, anything else is null (caller exits 2). */
export function parseThinking(v: string | undefined): Anthropic.ThinkingConfigParam | undefined | null {
  if (v === undefined) return undefined;
  return v === "disabled" || v === "adaptive" ? { type: v } : null;
}

export async function runInternalSdkJudge(args: string[]): Promise<number> {
  const promptFile = argVal(args, "--prompt-file");
  const schemaFile = argVal(args, "--schema-file");
  if (!promptFile || !schemaFile) {
    process.stderr.write("sdk-judge: --prompt-file and --schema-file are required\n");
    return 2;
  }

  let prompt: string;
  let schema: Record<string, unknown>;
  try {
    prompt = readFileSync(promptFile, "utf8");
    schema = JSON.parse(readFileSync(schemaFile, "utf8")) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(`sdk-judge: cannot read inputs: ${(e as Error).message}\n`);
    return 3;
  }

  // Defensive default only: every one of the 8 bash judge callers passes --model
  // explicitly (from a LOKI_SDK_*_MODEL env with its own default), so this literal
  // is not reached on the real dispatch path -- it just keeps a bare hand-run of
  // `loki internal sdk-judge` from erroring with no model.
  const model = resolveClaudeModel(argVal(args, "--model") ?? "haiku");
  if (isUnresolvedClaudeAlias(model)) {
    process.stderr.write(`sdk: model alias "${model}" did not resolve via the catalog; refusing to call the API\n`);
    return 2;
  }
  const effortRaw = argVal(args, "--effort");
  const effort = effortRaw && VALID_EFFORT.has(effortRaw) ? (effortRaw as Effort) : undefined;
  const maxTokens = parsePosInt(argVal(args, "--max-tokens"));
  const thinking = parseThinking(argVal(args, "--thinking"));
  if (thinking === null || thinkingConflictsEffort(model, thinking, effort)) {
    process.stderr.write(`${thinkingUsageError("sdk-judge", model)}\n`);
    return 2;
  }
  const timeoutMs = parsePosInt(argVal(args, "--timeout-ms"));

  const result = await judgeJsonOutcome({ prompt, schema, model, effort, maxTokens, thinking, timeoutMs, ledger: cliLedger(args, "sdk-judge") });
  if (result.kind !== "ok") {
    // fail-closed: no stdout, non-zero -> bash caller uses its fallback. The
    // cause is named on stderr, never a bare failure.
    process.stderr.write(`sdk-judge: outcome=${describeJudgeOutcome(result)}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(result.value));
  return 0;
}

// v8: `loki internal sdk-text` -- the free-form (no-schema) sibling of sdk-judge.
// For prose sites (grill, prd-enrich) whose callers parse the text themselves.
// Same fail-closed contract: 0 + text on success; non-zero + no stdout on any
// failure so the bash caller falls back to its existing claude path.
//   loki internal sdk-text --prompt-file P [--model M] [--effort ...] [--max-tokens N] [--timeout-ms N]
// Exit codes: 0 ok (+ text on stdout); 2 bad args; 3 read error; 1 null (no key /
// transport / refusal / empty). Only 0 prints stdout.
export async function runInternalSdkText(args: string[]): Promise<number> {
  const promptFile = argVal(args, "--prompt-file");
  if (!promptFile) {
    process.stderr.write("sdk-text: --prompt-file is required\n");
    return 2;
  }

  let prompt: string;
  try {
    prompt = readFileSync(promptFile, "utf8");
  } catch (e) {
    process.stderr.write(`sdk-text: cannot read prompt: ${(e as Error).message}\n`);
    return 3;
  }

  // Defensive default only: every one of the 8 bash judge callers passes --model
  // explicitly (from a LOKI_SDK_*_MODEL env with its own default), so this literal
  // is not reached on the real dispatch path -- it just keeps a bare hand-run of
  // `loki internal sdk-judge` from erroring with no model.
  const model = resolveClaudeModel(argVal(args, "--model") ?? "haiku");
  if (isUnresolvedClaudeAlias(model)) {
    process.stderr.write(`sdk: model alias "${model}" did not resolve via the catalog; refusing to call the API\n`);
    return 2;
  }
  const effortRaw = argVal(args, "--effort");
  const effort = effortRaw && VALID_EFFORT.has(effortRaw) ? (effortRaw as Effort) : undefined;
  const maxTokens = parsePosInt(argVal(args, "--max-tokens"));
  const thinking = parseThinking(argVal(args, "--thinking"));
  if (thinking === null || thinkingConflictsEffort(model, thinking, effort)) {
    process.stderr.write(`${thinkingUsageError("sdk-text", model)}\n`);
    return 2;
  }
  const timeoutMs = parsePosInt(argVal(args, "--timeout-ms"));

  const result = await judgeTextOutcome({ prompt, model, effort, maxTokens, thinking, timeoutMs, ledger: cliLedger(args, "sdk-text") });
  if (result.kind !== "ok") {
    process.stderr.write(`sdk-text: outcome=${describeJudgeOutcome(result)}\n`);
    return 1;
  }
  process.stdout.write(result.value);
  return 0;
}
