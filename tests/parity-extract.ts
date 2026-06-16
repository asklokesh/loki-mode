// tests/parity-extract.ts -- Bun-route value extractor for the automated
// bash<->Bun parity test (tests/test-bash-bun-parity.sh, backlog P4-2).
//
// This file does NOT test anything by itself. It imports the LOAD-BEARING
// parity constants/functions from the Bun route and prints them as ONE JSON
// blob to stdout. The bash harness extracts the SAME values from the bash
// route and compares matrix-to-matrix.
//
// Why execute-and-emit instead of regex-parsing claude_flags.ts: the effort,
// fallback, and override-text values are COMPUTED by code. Importing and
// calling the real functions tests BEHAVIOR (what a run actually sends), not
// source formatting, and it is robust to refactors that keep behavior stable.
//
// Run: bun run tests/parity-extract.ts
//
// No emojis, no em dashes (CLAUDE.md hard rule).

import {
  effortForTier,
  fallbackForPrimary,
  AUTONOMY_OVERRIDE_TEXT,
} from "../loki-ts/src/providers/claude_flags.ts";

// NOTE on PHASE_KEYS: it is a module-PRIVATE const in build_prompt.ts (not
// exported), so it cannot be imported here. The harness therefore text-extracts
// PHASE_KEYS directly from the REAL build_prompt.ts source file (see
// check_phase_keys in tests/test-bash-bun-parity.sh). It is deliberately NOT
// re-declared here: a hardcoded copy would make the parity test compare two
// routes against a third source of truth and pass while the routes drift.

// ---- effort-per-tier matrix --------------------------------------------------
// Cover every branch: each named tier + the default (*) branch, crossed with
// complexity standard vs complex (the one-notch bump).
const TIERS = [
  "planning",
  "development",
  "fast",
  "best",
  "balanced",
  "cheap",
  "__default__", // exercises the default branch (unknown tier)
];
const COMPLEXITIES = ["standard", "complex"];

const effort: Record<string, string> = {};
for (const tier of TIERS) {
  for (const cx of COMPLEXITIES) {
    // "__default__" is a sentinel for "unknown tier" -> hits the default branch.
    const tierArg = tier === "__default__" ? "totally-unknown-tier" : tier;
    effort[`${tier}|${cx}`] = effortForTier(tierArg, cx);
  }
}

// ---- fallback-model matrix ---------------------------------------------------
// opus/sonnet/haiku/other crossed with LOKI_ALLOW_HAIKU true/false.
const PRIMARIES = ["opus", "sonnet", "haiku", "gpt-5.3-codex"];
const fallback: Record<string, string> = {};
for (const primary of PRIMARIES) {
  for (const allowHaiku of [false, true]) {
    // fallbackForPrimary returns null when no fallback applies; normalize to ""
    // so it matches the bash route (which emits an empty string).
    const v = fallbackForPrimary(primary, allowHaiku);
    fallback[`${primary}|${allowHaiku ? "true" : "false"}`] = v ?? "";
  }
}

const out = {
  effort,
  fallback,
  autonomy_override_text: AUTONOMY_OVERRIDE_TEXT,
};

process.stdout.write(JSON.stringify(out));
