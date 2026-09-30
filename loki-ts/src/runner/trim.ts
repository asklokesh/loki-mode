// S41-11: LOKI_E10_TRIM=1 rule-based trajectory trimming (flag), D41 item 2 / D42.
// A PostToolUse hook that shortens NEW tool results before they enter the
// transcript. It never rewrites history -- rewriting history would break the
// cache-stable prefix (D41) -- so it only acts on the result of the call it
// fires for. Card: docs/v10/SCORECARD-PLAN.md S41-11.
//
// Verified Agent SDK PostToolUse contract (loki-ts/node_modules/@anthropic-ai/
// claude-agent-sdk/sdk.d.ts and sdk-tools.d.ts, package.json version 0.3.283 /
// claudeCodeVersion 2.1.283):
//   - Replacement field: PostToolUseHookSpecificOutput.updatedToolOutput
//     (sdk.d.ts:2677) -- "Replaces the tool output before it is sent to the
//     model". NOT updatedMCPToolOutput (sdk.d.ts:2681, MCP-only).
//   - Tool name: PostToolUseHookInput.tool_name (sdk.d.ts:2656). tool_response
//     is typed `unknown` (sdk.d.ts:2658); its concrete shape for Bash is
//     BashOutput (sdk-tools.d.ts:3236: stdout, stderr, interrupted,
//     returnCodeInterpretation?, ...), for Read is FileReadOutput
//     (sdk-tools.d.ts:205: {type:"text", file:{content, numLines, ...}} |
//     {type:"image", ...}), for Grep is GrepOutput (sdk-tools.d.ts:3495:
//     {filenames, content?, numMatches?, ...}).
//   - Callback signature: HookCallback = (input, toolUseID, options) =>
//     Promise<HookJSONOutput> (sdk.d.ts:961).
//   - NO numeric exit code is exposed to PostToolUse hooks in this SDK
//     version: confirmed absent from BashOutput and from every hook-input
//     type in sdk.d.ts/sdk-tools.d.ts. "Exits nonzero" below is therefore
//     a failing command cannot be detected reliably (pytest and npm test
//     print failures to stdout with an empty stderr), so the Bash tail is
//     never halved: it stays 120 lines in both regimes. Only the head and the
//     threshold halve, which keeps a failing command's tail intact.
//     ponytail: upgrade to a real field the day BashOutput/PostToolUseHookInput
//     grows one.
//
// Never returns an identity rewrite: hooks run in parallel on the ORIGINAL
// output, so an identity updatedToolOutput would last-write-wins clobber a
// sibling hook's real rewrite (sdk.d.ts:2671). An untrimmed call returns {}.

export interface TrimPostToolUseInput {
  tool_name: string;
  tool_response: unknown;
}

export interface TrimResult {
  hookSpecificOutput?: {
    hookEventName: "PostToolUse";
    updatedToolOutput: unknown;
  };
}

// From this 1-indexed call number on, every limit below halves.
const HALVE_FROM_CALL = 25;

interface Limits {
  bashThreshold: number;
  bashHead: number;
  bashTail: number;
  readKeep: number;
  grepKeep: number;
}

const BASE_LIMITS: Limits = {
  bashThreshold: 200,
  bashHead: 40,
  bashTail: 120,
  readKeep: 400,
  grepKeep: 100,
};

function limitsForCall(callNumber: number): Limits {
  if (callNumber < HALVE_FROM_CALL) return BASE_LIMITS;
  return {
    bashThreshold: BASE_LIMITS.bashThreshold / 2,
    bashHead: BASE_LIMITS.bashHead / 2,
    bashTail: BASE_LIMITS.bashTail, // never halves, see the exit-code note above
    readKeep: BASE_LIMITS.readKeep / 2,
    grepKeep: BASE_LIMITS.grepKeep / 2,
  };
}

// One trailing newline ends the last line, it does not start another.
function splitLines(text: string): string[] {
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

function trimBash(resp: Record<string, unknown>, limits: Limits): Record<string, unknown> | undefined {
  const stdout = resp["stdout"];
  if (typeof stdout !== "string") return undefined;
  const lines = splitLines(stdout);
  if (lines.length <= limits.bashThreshold) return undefined;
  const { bashHead: head, bashTail: tail } = limits;
  const kept = lines.length - head - tail;
  if (kept <= 0) return undefined;
  return {
    ...resp,
    stdout: [...lines.slice(0, head), `[loki trimmed ${kept} lines]`, ...lines.slice(lines.length - tail)].join(
      "\n",
    ),
  };
}

function trimRead(resp: Record<string, unknown>, limits: Limits): Record<string, unknown> | undefined {
  if (resp["type"] !== "text") return undefined; // image reads are untouched
  const file = resp["file"];
  if (file === null || typeof file !== "object") return undefined;
  const f = file as Record<string, unknown>;
  const content = f["content"];
  if (typeof content !== "string") return undefined;
  const lines = splitLines(content);
  if (lines.length <= limits.readKeep) return undefined;
  return { ...resp, file: { ...f, content: lines.slice(0, limits.readKeep).join("\n"), numLines: limits.readKeep } };
}

function trimGrep(resp: Record<string, unknown>, limits: Limits): Record<string, unknown> | undefined {
  const filenames = resp["filenames"];
  if (Array.isArray(filenames) && filenames.length > limits.grepKeep) {
    return { ...resp, filenames: filenames.slice(0, limits.grepKeep) };
  }
  const content = resp["content"];
  if (typeof content === "string") {
    const lines = content.split("\n");
    if (lines.length > limits.grepKeep) {
      return { ...resp, content: lines.slice(0, limits.grepKeep).join("\n") };
    }
  }
  return undefined;
}

// Pure rule application: given the PostToolUse input and this session's
// 1-indexed call number (every PostToolUse call counts, trimmable or not),
// returns the hook's JSON output. {} means "pass through unchanged".
export function trimToolOutput(input: TrimPostToolUseInput, callNumber: number): TrimResult {
  const resp = input.tool_response;
  if (resp === null || typeof resp !== "object") return {};
  const r = resp as Record<string, unknown>;
  const limits = limitsForCall(callNumber);
  let trimmed: Record<string, unknown> | undefined;
  switch (input.tool_name) {
    case "Bash":
      trimmed = trimBash(r, limits);
      break;
    case "Read":
      trimmed = trimRead(r, limits);
      break;
    case "Grep":
      trimmed = trimGrep(r, limits);
      break;
    default:
      return {};
  }
  if (!trimmed) return {};
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: trimmed } };
}

// Builds one PostToolUse hook callback with its own call counter, closed over
// per session/query() call (never module state -- concurrent sessions must
// not share a counter).
export function createTrimHook(): (input: unknown) => Promise<TrimResult> {
  let callCount = 0;
  return async (input: unknown) => {
    callCount += 1;
    return trimToolOutput(input as TrimPostToolUseInput, callCount);
  };
}
