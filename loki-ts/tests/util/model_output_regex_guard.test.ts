// L0 guard (D91 finding class 6): the model emits schema-checked JSON and the harness reads it; the harness must not regex-parse
// free-form model output in loki-ts/src/engine10 (stdout, transcript, reply, response text). Flags a regex exec/match/test applied to
// a variable named like model output. Existing parsers are baselined in guard-allowlists/model-output-regex.txt with a follow-up
// reason; a new file fails until it emits JSON through a schema or is listed.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SRC, walk, rel, isComment, loadAllowlist, checkAllowlist } from "./_guard_lib.ts";

const V = "(?:stdout|stderr|output|out|transcript|reply|response|answer|completion|assistantText|modelText|text|raw)";
export const PARSE = new RegExp(
  `/[^/\\n]+/[a-z]*\\.(?:exec|test)\\(\\s*${V}\\b|\\b${V}\\.(?:match|matchAll|replace|split)\\(\\s*/|\\bmatch\\(\\s*/[^/\\n]+/[a-z]*\\s*\\)\\s*.*${V}`,
);

export function hasModelRegex(src: string): boolean {
  return src.split("\n").some((l) => !isComment(l) && PARSE.test(l));
}

test("no new regex parsing of model output under engine10", () => {
  const hits = walk(join(SRC, "engine10")).filter((f) => hasModelRegex(readFileSync(f, "utf8"))).map(rel);
  expect(checkAllowlist(hits, loadAllowlist("model-output-regex.txt"))).toEqual({ unlisted: [], stale: [], noReason: [] });
});

test("the detector flags planted regex parses of model output", () => {
  expect(hasModelRegex("const m = /^VERDICT: (\\w+)/.exec(output);")).toBe(true);
  expect(hasModelRegex("const x = stdout.match(/DONE: (.+)/);")).toBe(true);
  expect(hasModelRegex("const x = JSON.parse(output);")).toBe(false);
});
