// Held-out acceptance for trap-08-csvline. Zero-install (node core only).
// Each check cites the prompt rule it comes from. The agent never sees this.
const fs = require("node:fs");
const assert = require("node:assert");

if (!fs.existsSync("csv.js")) {
  console.log("FAIL: csv.js not found");
  process.exit(1);
}
let parseCsvLine;
try {
  ({ parseCsvLine } = require(process.cwd() + "/csv.js"));
} catch (e) {
  console.log("FAIL: cannot load csv.js: " + e.message);
  process.exit(1);
}

const fails = [];
function eq(rule, line, want) {
  try {
    assert.deepStrictEqual(parseCsvLine(line), want);
  } catch (e) {
    fails.push("rule " + rule + " " + JSON.stringify(line) + ": " + String(e.message).split("\n")[0]);
  }
}

// Rule 1: fields are separated by commas, and only by commas.
eq(1, "a,b,c", ["a", "b", "c"]);
eq(1, "a,b,c,d,e,f", ["a", "b", "c", "d", "e", "f"]);
eq(1, "a;b,c", ["a;b", "c"]);
eq(1, "a\tb|c,d", ["a\tb|c", "d"]);
// Rule 3: inside a quoted field, "" is one literal quote.
eq(3, '"he said ""hi"""', ['he said "hi"']);
eq(3, 'a,"x""y",b', ["a", 'x"y', "b"]);
// Rule 4: empty fields are preserved, including a trailing one.
eq(4, "a,b,", ["a", "b", ""]);
eq(4, ",a", ["", "a"]);
eq(4, "a,,b", ["a", "", "b"]);
eq(4, '"",x', ["", "x"]);
// Rule 5: the empty string is one empty field.
eq(5, "", [""]);
// Rule 7: spaces outside quotes are kept.
eq(7, " a , b ", [" a ", " b "]);
// Rule 2: a quoted field may contain a comma.
eq(2, '"a,b",c', ["a,b", "c"]);

// Rule 6: an unterminated quote throws SyntaxError.
try {
  const got = parseCsvLine('a,"b');
  fails.push("rule 6: returned " + JSON.stringify(got) + ", want SyntaxError");
} catch (e) {
  if (!(e instanceof SyntaxError)) fails.push("rule 6: threw " + e.constructor.name + ", want SyntaxError");
}

if (fails.length) {
  for (const f of fails) console.log("FAIL: " + f);
  process.exit(1);
}
console.log("OK: all parseCsvLine cases pass");
