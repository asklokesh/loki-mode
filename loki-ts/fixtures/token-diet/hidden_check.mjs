// Outcome oracle for the experiment (never shown to the model). Usage: node hidden_check.mjs <repoDir>
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const dir = process.argv[2];
const { parseArgs } = await import(pathToFileURL(`${dir}/src/parse.js`).href);
const O = [{ name: "verbose", alias: "v" }, { name: "out", alias: "o", type: "string" }];
const r = [];
const t = (name, fn) => { try { fn(); r.push([name, "pass"]); } catch (e) { r.push([name, "FAIL " + e.message.split("\n")[0]]); } };
t("operand keeps rest", () => assert.deepEqual(parseArgs(["-", "foo", "bar"]).positionals, ["-", "foo", "bar"]));
t("parsing continues", () => { const x = parseArgs(["-", "--verbose", "x"], O); assert.equal(x.values.verbose, true); assert.deepEqual(x.positionals, ["-", "x"]); });
t("counts toward stopAt", () => { const x = parseArgs(["-", "a", "--verbose"], O, { stopAtPositional: 1 }); assert.deepEqual(x.positionals, ["-", "a", "--verbose"]); assert.equal(x.values.verbose, false); });
t("double dash intact", () => assert.deepEqual(parseArgs(["--", "-", "x"], O).positionals, ["-", "x"]));
t("regression test added", () => assert.match(readFileSync(`${dir}/test/parse.test.js`, "utf8"), /\[\s*["'`]-["'`]\s*,/));
console.log(JSON.stringify(r));
process.exit(r.every(([, s]) => s === "pass") ? 0 : 1);
