// Stub-provider logic check for features/token_diet.ts. Usage: bun stub_check.ts <scratch dir>. Prints one PASS/FAIL line per assertion.
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyBlocks, buildPatchBrief, digest, dossier, parseReply, runDiet, type ModelCall } from "../../src/features/token_diet.ts";

const here = import.meta.dir, scratch = process.argv[2]!;
let fails = 0;
const t = (name: string, cond: boolean): void => { console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}`); if (!cond) fails++; };
const fresh = (n: string): string => { const d = join(scratch, n); cpSync(join(here, "argkit"), d, { recursive: true }); return d; };
const task = readFileSync(join(here, "task.md"), "utf8");
const CHECK = "node --test test/*.test.js";
const BREAK = '    // a lone "-"\n    if (token.length === 1) {\n      positionals.push(token);\n      break;\n    }\n';
const usage = { input: 1, output: 10, cacheRead: 100, cacheCreate: 50, usd: 0.001, turns: 1 };
const scripted = (replies: string[], seen: string[]): ModelCall => async (m, resume) => { seen.push(`${resume ?? "new"}::${m}`); return { text: replies.shift() ?? "LOKI_DONE", sessionId: "s1", usage }; };
const block = (file: string, search: string, replace: string): string => `FILE: ${file}\n<<<<<<< SEARCH\n${search}=======\n${replace}>>>>>>> REPLACE\n`;
const TEST_ADD = 'test("lone dash is an operand", () => {\n  const r = parseArgs(["-", "--verbose", "x"], OPTS);\n  assert.equal(r.values.verbose, true);\n  assert.deepEqual(r.positionals, ["-", "x"]);\n});\n';

// 1. dossier: the named function verbatim, the covering test file's convention, the check command
const d0 = fresh("d0"), dz = dossier(d0, task, CHECK);
t("dossier carries parseArgs verbatim", dz.text.includes(BREAK) && dz.text.includes("export function parseArgs("));
t("dossier names the covering test file", dz.text.includes("--- test/parse.test.js:1-") && dz.files.includes("src/parse.js"));
t("dossier carries the check command", dz.text.includes(`Check command (the harness runs it after your edits): ${CHECK}`));
t("dossier leaves out unrelated files", !dz.text.includes("function wrap(") && !dz.text.includes("export function fromEnv"));

// 2. wrong first patch (terminator semantics) -> red -> digest + current regions -> repair -> green in 2 rounds
const d1 = fresh("d1"), seen: string[] = [];
const wrong = "Root cause: break.\n" + block("src/parse.js", BREAK, '    // a lone "-"\n    if (token.length === 1) {\n      positionals.push(...rest);\n      return { values, positionals };\n    }\n') + block("test/parse.test.js", "", TEST_ADD) + "LOKI_DONE";
const right = block("src/parse.js", '    // a lone "-"\n    if (token.length === 1) {\n      positionals.push(...rest);\n      return { values, positionals };\n    }\n', '    // a lone "-"\n    if (token.length === 1) {\n      positionals.push(token);\n      continue;\n    }\n') + "LOKI_DONE";
const r1 = await runDiet({ repoDir: d1, brief: buildPatchBrief(task, dz.text), checkCmd: CHECK, call: scripted([wrong, right], seen) });
t("wrong patch then repair ends green in 2 rounds", r1.status === "green" && r1.rounds === 2);
t("repair round resumes the same session", seen[1]?.startsWith("s1::") === true);
t("repair message carries the failure digest", /FAILED[\s\S]*lone dash is an operand/.test(seen[1] ?? ""));
t("repair message carries the current edited region", (seen[1] ?? "").includes("positionals.push(...rest);\n      return { values, positionals };"));
t("usage summed over rounds", r1.usage.cacheRead === 200 && r1.usage.turns === 2);
t("repaired tree passes the outcome oracle", Bun.spawnSync(["node", join(here, "hidden_check.mjs"), d1]).exitCode === 0);

// 3. all-or-nothing: one missing SEARCH applies nothing and points at the nearest text
const d2 = fresh("d2"), before = readFileSync(join(d2, "src/parse.js"), "utf8");
const a2 = applyBlocks(d2, [{ file: "test/parse.test.js", search: "", replace: "X\n" }, { file: "src/parse.js", search: '    if (token.length === 1) {\n      positionals.push(token);\n      brake;\n', replace: "Y\n" }]);
t("a missing SEARCH applies nothing", !a2.ok && readFileSync(join(d2, "src/parse.js"), "utf8") === before && !readFileSync(join(d2, "test/parse.test.js"), "utf8").endsWith("X\n"));
t("the miss report shows the nearest text", /block 2 .*not found\. Nearest text, src\/parse\.js:\d+-\d+:\n[\s\S]*token\.length === 1/.test(a2.errors[0] ?? ""));

// 4. read-only Wall test and path escapes are refused
const a3 = applyBlocks(d2, [{ file: "test/parse.test.js", search: "", replace: "x" }], ["test/parse.test.js"]);
const a4 = applyBlocks(d2, [{ file: "../evil.js", search: "", replace: "x" }]);
t("a read-only test is refused", !a3.ok && /read-only/.test(a3.errors[0] ?? ""));
t("a path outside the repo is refused", !a4.ok);

// 5. NEED: one read round, then edits
const d3 = fresh("d3"), seen3: string[] = [];
const fix = block("src/parse.js", BREAK, '    // a lone "-"\n    if (token.length === 1) {\n      positionals.push(token);\n      continue;\n    }\n') + block("test/parse.test.js", "", TEST_ADD) + "LOKI_DONE";
const r3 = await runDiet({ repoDir: d3, brief: "b", checkCmd: CHECK, call: scripted(["NEED: src/coerce.js:1-5", fix], seen3) });
t("NEED is answered with the requested lines, then green", r3.status === "green" && r3.rounds === 2 && (seen3[1] ?? "").includes("--- src/coerce.js:1-5\nimport { SpecError }"));

// 6. never green on a red check: exhausted rounds return red for the agentic fallback
const d4 = fresh("d4");
const r4 = await runDiet({ repoDir: d4, brief: "b", checkCmd: "exit 1", call: scripted([fix, "LOKI_DONE", "LOKI_DONE"], []), maxRounds: 3 });
t("a check that never passes returns red (agentic fallback)", r4.status === "red" && r4.rounds === 3);

// 7. parse and digest
const p = parseReply("x\nLOKI_SPEC_CONFLICT: test/a.test.js:3 wants terminator semantics");
t("spec conflict is parsed", p.conflict === "test/a.test.js:3 wants terminator semantics" && !p.done);
const big = Array.from({ length: 400 }, (_, i) => `ok ${i} noise line`).join("\n") + "\nnot ok 401 - lone dash\n  AssertionError: Expected values to be strictly deep-equal\n  + actual - expected\n# fail 1";
const dg = digest(big);
t("digest keeps the failure and drops the noise", dg.length < 1500 && dg.includes("not ok 401") && dg.includes("AssertionError") && !dg.includes("ok 17 noise"));
process.exit(fails ? 1 : 0);
