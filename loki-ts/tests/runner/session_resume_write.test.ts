// writeSessionId: the producer of the e10-session-<iter>.json id the warm chain resumes from.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSdkStream, type StreamMsg } from "../../src/runner/sdk_stream_parser.ts";
import { readSessionId, writeSessionId } from "../../src/runner/session_resume.ts";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "loki-sesswrite-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });
const ctx = () => ({ cwd: scratch, iteration: "1", hookEventsEnabled: true, write: (_s: string) => {} });

describe("writeSessionId", () => {
  test("a model_refusal_no_fallback turn is not resumed: id not written, stale id removed", async () => {
    writeSessionId(scratch, "1", { sessionId: "stale-id" });
    expect(readSessionId(scratch, "1")).toBe("stale-id");
    const msgs: StreamMsg[] = [
      { type: "system", subtype: "model_refusal_no_fallback", original_model: "opus", session_id: "refused-sess" },
      { type: "result", subtype: "success", is_error: true, session_id: "refused-sess" },
    ];
    const res = await consumeSdkStream(msgs, ctx());
    writeSessionId(scratch, "1", res);
    expect(readSessionId(scratch, "1")).toBeNull();
  });

  test("a truncated turn (no result frame) still resumes with its session id (g08-53)", async () => {
    const msgs: StreamMsg[] = [
      { type: "assistant", session_id: "trunc-sess", message: { content: [{ type: "text", text: "partial" }] } },
    ];
    const res = await consumeSdkStream(msgs, ctx());
    expect(res.truncated).toBe(true);
    expect(res.sessionId).toBe("trunc-sess");
    writeSessionId(scratch, "1", res);
    expect(readSessionId(scratch, "1")).toBe("trunc-sess");
  });
});
