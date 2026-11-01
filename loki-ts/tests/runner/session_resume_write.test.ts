// writeSessionId: the producer of the e10-session-<iter>.json id the warm chain resumes from.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSdkStream, type StreamMsg } from "../../src/runner/sdk_stream_parser.ts";
import { migrateSessionFiles, readSessionId, sessionFilePath, writeSessionId } from "../../src/runner/session_resume.ts";

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

describe("session files live in the run directory, never loose in .loki/", () => {
  const runId = "e10-20261031T120000Z-ab12";
  const runDir = () => join(scratch, ".loki", "runs", runId);
  test("an iteration of a run with a run dir writes there and reads back", () => {
    mkdirSync(runDir(), { recursive: true });
    writeSessionId(scratch, `${runId}-impl`, { sessionId: "s1" });
    expect(sessionFilePath(scratch, `${runId}-impl`)).toBe(join(runDir(), `e10-session-${runId}-impl.json`));
    expect(existsSync(join(runDir(), `e10-session-${runId}-impl.json`))).toBe(true);
    expect(readdirSync(join(scratch, ".loki")).filter((n) => n.startsWith("e10-session-"))).toEqual([]);
    expect(readSessionId(scratch, `${runId}-impl`)).toBe("s1");
  });
  test("a file an older release left loose is still read, and the next run moves it into its run dir", () => {
    mkdirSync(runDir(), { recursive: true });
    const loose = join(scratch, ".loki", `e10-session-${runId}-impl.json`), orphan = join(scratch, ".loki", "e10-session-r9-fix1.json");
    writeFileSync(loose, JSON.stringify({ session_id: "old" })); writeFileSync(orphan, JSON.stringify({ session_id: "o" }));
    expect(readSessionId(scratch, `${runId}-impl`)).toBe("old");
    expect(migrateSessionFiles(scratch)).toBe(2);
    expect(existsSync(loose)).toBe(false); expect(existsSync(orphan)).toBe(false);
    expect(readSessionId(scratch, `${runId}-impl`)).toBe("old");
    expect(existsSync(join(scratch, ".loki", "sessions", "e10-session-r9-fix1.json"))).toBe(true);
  });
  test("a loose file of a live run stays where that run reads it", () => {
    mkdirSync(runDir(), { recursive: true });
    const loose = join(scratch, ".loki", `e10-session-${runId}-impl.json`);
    writeFileSync(loose, JSON.stringify({ session_id: "live" }));
    expect(migrateSessionFiles(scratch, (d) => d === runDir())).toBe(0);
    expect(existsSync(loose)).toBe(true);
  });
});
