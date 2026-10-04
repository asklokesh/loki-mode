// CP-ASK slice 8: pure parser from a provider's streaming output to Ask events.
// No I/O and no spawn.ts import. claude shapes mirror loki-ts/src/runner/sdk_stream_parser.ts.
// codex (exec --json) and opencode are DEGRADED: no codex parser exists in loki-ts, so the
// codex shapes here (item.completed agent_message/command_execution, turn.completed) are minimal
// and carry no cost; opencode falls back to plain-text deltas.

export type AskProvider = "claude" | "codex" | "opencode";
export type AskEventKind = "delta" | "tool_use" | "tool_result" | "result" | "error";
export interface AskEvent { kind: AskEventKind; payload: Record<string, unknown> }
export interface ParseState {
  text: string;
  sawResult: boolean;
  sawStreamDelta: boolean;
  isError: boolean;
  error?: string;
  costUsd?: number;
  resultText?: string;
}
export interface Outcome { status: "done" | "failed"; text: string; costUsd?: number; error?: string }

export function newState(): ParseState {
  return { text: "", sawResult: false, sawStreamDelta: false, isError: false };
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function delta(state: ParseState, text: string, out: AskEvent[]): void {
  if (!text) return;
  state.text += text;
  out.push({ kind: "delta", payload: { text } });
}

function claude(o: Record<string, any>, state: ParseState, out: AskEvent[]): void {
  switch (o.type) {
    case "stream_event": {
      const d = o.event?.delta;
      if (o.event?.type === "content_block_delta" && d?.type === "text_delta" && typeof d.text === "string") {
        state.sawStreamDelta = true;
        delta(state, d.text, out);
      }
      return;
    }
    case "assistant": {
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (!isObj(b)) continue;
        // With partial messages on, the text already arrived as stream deltas.
        if (b.type === "text" && !state.sawStreamDelta && typeof b.text === "string") delta(state, b.text, out);
        else if (b.type === "tool_use") out.push({ kind: "tool_use", payload: { id: b.id, name: b.name, input: b.input ?? {} } });
      }
      // A complete assistant message ends the streamed span; the next message starts fresh.
      state.sawStreamDelta = false;
      return;
    }
    case "user": {
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (isObj(b) && b.type === "tool_result") out.push({ kind: "tool_result", payload: { tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error === true } });
      }
      return;
    }
    case "result": {
      state.sawResult = true;
      state.isError = o.is_error === true || (typeof o.subtype === "string" && o.subtype !== "success");
      if (typeof o.total_cost_usd === "number") state.costUsd = o.total_cost_usd;
      if (typeof o.result === "string") state.resultText = o.result;
      if (state.isError) state.error = typeof o.result === "string" && o.result ? o.result : String(o.subtype ?? "error");
      out.push({ kind: "result", payload: { text: state.resultText ?? state.text, costUsd: state.costUsd, isError: state.isError } });
    }
  }
}

function codex(o: Record<string, any>, state: ParseState, out: AskEvent[]): void {
  if (o.type === "item.completed" && isObj(o.item)) {
    const it = o.item;
    if (it.type === "agent_message" && typeof it.text === "string") delta(state, it.text, out);
    else if (it.type === "command_execution") {
      out.push({ kind: "tool_use", payload: { id: it.id, name: "command_execution", input: { command: it.command } } });
      out.push({ kind: "tool_result", payload: { tool_use_id: it.id, content: it.aggregated_output, is_error: typeof it.exit_code === "number" && it.exit_code !== 0 } });
    }
  } else if (o.type === "turn.completed") {
    state.sawResult = true;
    out.push({ kind: "result", payload: { text: state.text, isError: false } });
  } else if (o.type === "turn.failed" || o.type === "error") {
    state.sawResult = true;
    state.isError = true;
    state.error = String(o.error?.message ?? o.message ?? "error");
    out.push({ kind: "result", payload: { text: state.text, isError: true } });
  }
}

export function parseLine(provider: AskProvider, line: string, state: ParseState): AskEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const out: AskEvent[] = [];
  if (provider === "opencode") {
    // Degraded: plain text, no structured events or cost; the caller calls markComplete on a clean exit.
    delta(state, line.endsWith("\n") ? line : `${line}\n`, out);
    return out;
  }
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return [{ kind: "error", payload: { message: "malformed json line", line: trimmed.slice(0, 200) } }];
  }
  if (!isObj(o)) return [{ kind: "error", payload: { message: "unexpected non-object line", line: trimmed.slice(0, 200) } }];
  if (provider === "claude") claude(o, state, out);
  else codex(o, state, out);
  return out;
}

export function markComplete(state: ParseState): void {
  state.sawResult = true;
}

export function finish(state: ParseState): Outcome {
  const text = state.resultText ?? state.text;
  if (!state.sawResult) return { status: "failed", text, costUsd: state.costUsd, error: "stream ended without a result" };
  if (state.isError) return { status: "failed", text, costUsd: state.costUsd, error: state.error ?? "provider reported an error" };
  return { status: "done", text, costUsd: state.costUsd };
}
