// S41-11: rule-based trajectory trimming (LOKI_E10_TRIM=1). One test per rule
// in the card (docs/v10/SCORECARD-PLAN.md S41-11), red first.
import { describe, expect, it } from "bun:test";
import { createTrimHook, trimToolOutput } from "../../src/runner/trim.ts";

function bash(stdout: string, extra: Record<string, unknown> = {}) {
  return { tool_name: "Bash", tool_response: { stdout, stderr: "", interrupted: false, ...extra } };
}
function lines(n: number, prefix = "l"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");
}

describe("trimToolOutput", () => {
  it("Bash over 200 lines: keeps first 40 + last 120 + a [loki trimmed N lines] marker", () => {
    const out = trimToolOutput(bash(lines(250)), 1);
    const stdout = (out.hookSpecificOutput?.updatedToolOutput as { stdout: string }).stdout;
    const got = stdout.split("\n");
    expect(got.slice(0, 40)).toEqual(Array.from({ length: 40 }, (_, i) => `l${i}`));
    expect(got.at(-1)).toBe("l249");
    expect(got.slice(-120)).toEqual(Array.from({ length: 120 }, (_, i) => `l${130 + i}`));
    expect(got).toContain("[loki trimmed 90 lines]");
  });

  it("Bash at or under 200 lines: passes through unchanged ({})", () => {
    expect(trimToolOutput(bash(lines(200)), 1)).toEqual({});
  });

  it("Read over 400 lines: keeps the first 400", () => {
    const input = {
      tool_name: "Read",
      tool_response: { type: "text", file: { filePath: "/x", content: lines(500), numLines: 500, startLine: 1, totalLines: 500 } },
    };
    const out = trimToolOutput(input, 1);
    const file = (out.hookSpecificOutput?.updatedToolOutput as { file: { content: string } }).file;
    expect(file.content.split("\n")).toEqual(Array.from({ length: 400 }, (_, i) => `l${i}`));
  });

  it("Read at or under 400 lines: passes through unchanged", () => {
    const input = {
      tool_name: "Read",
      tool_response: { type: "text", file: { filePath: "/x", content: lines(400), numLines: 400, startLine: 1, totalLines: 400 } },
    };
    expect(trimToolOutput(input, 1)).toEqual({});
  });

  it("Grep over 100 matches: keeps the first 100 filenames", () => {
    const filenames = Array.from({ length: 150 }, (_, i) => `f${i}.ts`);
    const input = { tool_name: "Grep", tool_response: { mode: "files_with_matches", numFiles: 150, filenames } };
    const out = trimToolOutput(input, 1);
    const got = (out.hookSpecificOutput?.updatedToolOutput as { filenames: string[] }).filenames;
    expect(got).toEqual(filenames.slice(0, 100));
  });

  it("Grep at or under 100 matches: passes through unchanged", () => {
    const filenames = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const input = { tool_name: "Grep", tool_response: { mode: "files_with_matches", numFiles: 100, filenames } };
    expect(trimToolOutput(input, 1)).toEqual({});
  });

  it("from call 25 on, the limits halve: Bash keeps first 20 + last 60", () => {
    const out24 = trimToolOutput(bash(lines(250)), 24);
    const stdout24 = (out24.hookSpecificOutput?.updatedToolOutput as { stdout: string }).stdout.split("\n");
    expect(stdout24.slice(0, 40).length).toBe(40); // call 24: still base limits

    const out25 = trimToolOutput(bash(lines(250)), 25);
    const stdout25 = (out25.hookSpecificOutput?.updatedToolOutput as { stdout: string }).stdout.split("\n");
    expect(stdout25.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `l${i}`));
    expect(stdout25.slice(-60)).toEqual(Array.from({ length: 60 }, (_, i) => `l${190 + i}`));
  });

  it("from call 25 on, Read halves to 200 and Grep halves to 50", () => {
    const readInput = {
      tool_name: "Read",
      tool_response: { type: "text", file: { filePath: "/x", content: lines(500), numLines: 500, startLine: 1, totalLines: 500 } },
    };
    const readOut = trimToolOutput(readInput, 25);
    const readFile = (readOut.hookSpecificOutput?.updatedToolOutput as { file: { content: string } }).file;
    expect(readFile.content.split("\n").length).toBe(200);

    const filenames = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
    const grepInput = { tool_name: "Grep", tool_response: { mode: "files_with_matches", numFiles: 80, filenames } };
    const grepOut = trimToolOutput(grepInput, 25);
    const got = (grepOut.hookSpecificOutput?.updatedToolOutput as { filenames: string[] }).filenames;
    expect(got.length).toBe(50);
  });

  it("a Bash command that exits nonzero (non-empty stderr) always keeps the full 120-line tail, even past call 25", () => {
    const failed = bash(lines(250), { stderr: "boom" });
    const out = trimToolOutput(failed, 30); // well past the halving point
    const stdout = (out.hookSpecificOutput?.updatedToolOutput as { stdout: string }).stdout.split("\n");
    // head still halves (20), tail stays the full 120 regardless of call number.
    expect(stdout.slice(0, 20).length).toBe(20);
    expect(stdout.slice(-120)).toEqual(Array.from({ length: 120 }, (_, i) => `l${130 + i}`));
  });

  it("a tool this hook does not know about passes through unchanged", () => {
    expect(trimToolOutput({ tool_name: "Edit", tool_response: { filePath: "/x" } }, 1)).toEqual({});
  });

  it("createTrimHook counts every PostToolUse call for one session, trimmable or not", async () => {
    const hook = createTrimHook();
    for (let i = 0; i < 24; i++) {
      // 24 cheap non-trimmable calls to advance the counter without asserting on them.
      await hook({ tool_name: "Edit", tool_response: {} });
    }
    // The 25th call for this session hits the halved Bash limits.
    const out = await hook(bash(lines(250)));
    const stdout = (out.hookSpecificOutput?.updatedToolOutput as { stdout: string }).stdout.split("\n");
    expect(stdout.slice(0, 20).length).toBe(20);
  });
});
