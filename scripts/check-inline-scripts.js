#!/usr/bin/env node
//
// check-inline-scripts.js
//
// Parses every INLINE <script> block (no src= attribute) from an HTML file
// and runs a real JavaScript parse on it via Node's vm. Exits nonzero if any
// inline block has a syntax error.
//
// Why this exists: dashboard/static/index.html is a single-file SPA built by
// dashboard-ui/build-standalone.js. A build regression once corrupted the
// backslash escapes inside an inline <script>, shipping an index.html that
// served HTTP 200 and passed every "is the file present / does it contain
// markers" check, yet the SPA was dead because the inline JS threw a
// SyntaxError in the browser. HTTP-200 + build-composes checks all missed it.
// This gate parses the actual inline JS so a corrupt build fails local-ci.
//
// Usage:
//   node scripts/check-inline-scripts.js path/to/index.html
//
// Exit codes:
//   0  every inline <script> block parses
//   1  at least one inline <script> block has a syntax error
//   2  usage error (file missing / unreadable)

const fs = require("fs");
const vm = require("vm");

const file = process.argv[2];
if (!file) {
  console.error("usage: node check-inline-scripts.js <html-file>");
  process.exit(2);
}

let html;
try {
  html = fs.readFileSync(file, "utf8");
} catch (e) {
  console.error("cannot read " + file + ": " + e.message);
  process.exit(2);
}

// Match each <script ...>...</script> pair. The body capture is non-greedy so
// nested escaped "&lt;script" inside a string does not confuse the matcher
// (escaped entities are not literal "</script>" close tags).
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

let m;
let index = 0;
let inlineCount = 0;
let failures = 0;
let moduleSkipped = 0;

while ((m = re.exec(html)) !== null) {
  index += 1;
  const attrs = m[1] || "";
  const body = m[2] || "";

  // Skip external scripts (src=...). Only inline JS is parse-checked here.
  if (/\bsrc\s*=/i.test(attrs)) {
    continue;
  }
  // Skip non-JS script blocks (e.g. application/json data islands, importmap).
  // ES module blocks (type="module") are also skipped: new vm.Script() compiles
  // in classic-script context and would throw a FALSE-POSITIVE SyntaxError on a
  // valid top-level import/export. The dashboard SPA emits classic inline
  // scripts (the bug class this gate guards is build-corrupted classic JS), so
  // skipping module blocks loses no coverage today. If the build ever emits an
  // inline module, switch to vm.SourceTextModule under --experimental-vm-modules.
  const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
  if (typeMatch) {
    const t = typeMatch[1].toLowerCase();
    const classicJsTypes = ["text/javascript", "application/javascript", "text/ecmascript"];
    if (t === "module") {
      moduleSkipped += 1;
      continue;
    }
    if (!classicJsTypes.includes(t)) {
      continue;
    }
  }
  // Empty / whitespace-only inline blocks are trivially valid.
  if (body.trim() === "") {
    continue;
  }

  inlineCount += 1;
  try {
    // new vm.Script() compiles (parses) without executing. This surfaces
    // SyntaxErrors exactly like the browser parser would, without running
    // any browser-only globals.
    // eslint-disable-next-line no-new
    new vm.Script(body, { filename: file + " [inline-script #" + inlineCount + "]" });
  } catch (e) {
    failures += 1;
    console.error(
      "SYNTAX ERROR in inline <script> block #" + inlineCount +
      " (overall tag #" + index + ") of " + file + ":"
    );
    console.error("  " + e.message);
  }
}

if (inlineCount === 0) {
  // A file with only module blocks (all skipped) is not a failure: we simply
  // have nothing classic to parse-check. Only a file with no script blocks at
  // all (or no classic inline ones AND no modules) is suspicious.
  if (moduleSkipped > 0) {
    console.log("no classic inline <script> blocks in " + file +
      " (" + moduleSkipped + " module block(s) skipped)");
    process.exit(0);
  }
  console.error("no inline <script> blocks found in " + file + " (expected at least one)");
  process.exit(1);
}

if (failures > 0) {
  console.error(failures + " inline <script> block(s) failed to parse in " + file);
  process.exit(1);
}

console.log(inlineCount + " inline <script> block(s) parsed OK in " + file);
process.exit(0);
