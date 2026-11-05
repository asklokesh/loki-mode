// Outcome oracle for task B (never shown to the model). Usage: node hidden_check_b.mjs <repoDir>
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const dir = process.argv[2];
const { parseArgs } = await import(pathToFileURL(`${dir}/src/parse.js`).href);
const { fromEnv } = await import(pathToFileURL(`${dir}/src/env.js`).href);
const O = [{ name: "verbose", alias: "v" }];
const r = [];
const t = (name, fn) => { try { fn(); r.push([name, "pass"]); } catch (e) { r.push([name, "FAIL " + e.message.split("\n")[0]]); } };
t("cli on/off", () => { assert.equal(parseArgs(["--verbose=on"], O).values.verbose, true); assert.equal(parseArgs(["--verbose=OFF"], O).values.verbose, false); });
t("cli case", () => { assert.equal(parseArgs(["--verbose=True"], O).values.verbose, true); assert.equal(parseArgs(["--verbose= no "], O).values.verbose, false); });
t("env", () => { assert.deepEqual(fromEnv([{ name: "verbose" }, { name: "dry_run" }], { ARGKIT_VERBOSE: "ON", ARGKIT_DRY_RUN: "True" }), { verbose: true, "dry-run": true }); });
t("still rejects junk", () => assert.throws(() => parseArgs(["--verbose=maybe"], O), /expects a boolean/));
t("tests added", () => { assert.match(readFileSync(`${dir}/test/parse.test.js`, "utf8"), /["']--verbose=(on|ON|On|off|OFF)/); assert.match(readFileSync(`${dir}/test/env.test.js`, "utf8"), /(ON|on|On|True|OFF|off)["']/); });
console.log(JSON.stringify(r));
process.exit(r.every(([, s]) => s === "pass") ? 0 : 1);
