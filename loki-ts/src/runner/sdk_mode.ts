/**
 * sdk_mode.ts -- v8.1 Story 2: one-switch SDK activation resolver (TS side).
 *
 * Byte-mirror of autonomy/lib/sdk-mode.sh. v8 gave every claude judge/text site
 * and the RARV loop its own LOKI_SDK_* flag; this adds ONE operator switch,
 * LOKI_SDK_MODE (off|judges|full, default off), that sets the default for all of
 * them at once. LOKI_SDK is an alias (1|on|judges -> judges; full -> full).
 *
 * WHY A TS COPY (not just the bash resolver): the bash resolver runs in run.sh
 * and its resolved env is inherited by child processes. But the Bun route
 * (cli.ts dispatch, reached via the bin/loki shim when LOKI_SDK_LOOP is truthy)
 * runs IN-PROCESS -- its SDK sites (providers.ts, voter_agents.ts,
 * quality_gates.ts) read LOKI_SDK_* fresh from process.env. Without this, an
 * operator who sets only LOKI_SDK_MODE=full and lands on the Bun route would see
 * the per-site flags UNSET (mode not honored). resolveSdkMode() closes that gap.
 *
 * PARITY: the TS SDK sites read with a MIX of predicates -- strict `=== "1"`
 * (voter_agents.ts, quality_gates.ts) and truthy() (providers.ts LOKI_SDK_LOOP).
 * So we write the literal string "1" / "0", which satisfies BOTH. Same table as
 * the bash resolver; asserted against the shared fixture test/fixtures/
 * sdk-mode-table.json.
 *
 * INV-OFF: mode unset/off -> mutate NOTHING (byte-identical to v8).
 * INV-OVERRIDE: an explicit per-site flag (even "0") wins over the mode -- we
 * only write a var that is currently UNDEFINED in process.env.
 *
 * No emojis. No em dashes.
 */

export type SdkMode = "off" | "judges" | "full";

// The 7 one-shot judge/text flags (loop is separate). Keep in sync with
// _LOKI_SDK_JUDGE_VARS in autonomy/lib/sdk-mode.sh and the parity fixture.
const JUDGE_VARS = [
  "LOKI_SDK_DONE_RECOG",
  "LOKI_SDK_COUNCIL_V2",
  "LOKI_SDK_CODE_REVIEW",
  "LOKI_SDK_COUNCIL_VOTE",
  "LOKI_SDK_VOTER_AGENTS",
  "LOKI_SDK_GRILL",
  "LOKI_SDK_PRD_ENRICH",
] as const;

const LOOP_VAR = "LOKI_SDK_LOOP";

/**
 * Normalize LOKI_SDK_MODE / LOKI_SDK into a canonical mode. Unknown values fall
 * back to "off" (fail-safe: never turn the SDK on from a typo). LOKI_SDK_MODE
 * takes precedence over the LOKI_SDK alias.
 */
export function canonicalSdkMode(env: Record<string, string | undefined>): SdkMode {
  const modeRaw = (env["LOKI_SDK_MODE"] ?? "").trim().toLowerCase();
  if (modeRaw === "judges") return "judges";
  if (modeRaw === "full") return "full";
  if (modeRaw === "off") return "off";
  if (modeRaw !== "") return "off"; // unknown explicit mode -> off

  // Fall back to the LOKI_SDK alias only when LOKI_SDK_MODE is empty/unset.
  const aliasRaw = (env["LOKI_SDK"] ?? "").trim().toLowerCase();
  switch (aliasRaw) {
    case "1":
    case "on":
    case "true":
    case "yes":
    case "judges":
      return "judges";
    case "full":
      return "full";
    default:
      return "off";
  }
}

/**
 * Compute the resolved flag values for a mode, WITHOUT applying overrides. This
 * is the pure table used by the parity fixture. Returns the value each var would
 * take if unset; "off" returns an empty object (writes nothing).
 */
export function sdkModeDefaults(mode: SdkMode): Record<string, "0" | "1"> {
  if (mode === "off") return {};
  const out: Record<string, "0" | "1"> = {};
  for (const v of JUDGE_VARS) out[v] = "1";
  out[LOOP_VAR] = mode === "full" ? "1" : "0";
  return out;
}

/**
 * Resolve LOKI_SDK_MODE into the per-site LOKI_SDK_* flags by mutating `env`
 * (defaults to process.env) IN PLACE. Writes a var ONLY when it is currently
 * undefined, so an explicit per-site flag always wins (INV-OVERRIDE). Off/unset
 * mode writes nothing (INV-OFF). Idempotent; safe to call more than once.
 *
 * Call ONCE at the Bun entrypoint (cli.ts dispatch) before any SDK site runs.
 */
export function resolveSdkMode(
  env: Record<string, string | undefined> = process.env,
): SdkMode {
  const mode = canonicalSdkMode(env);
  if (mode === "off") return mode; // INV-OFF: mutate nothing.
  const defaults = sdkModeDefaults(mode);
  for (const [name, val] of Object.entries(defaults)) {
    if (env[name] === undefined) env[name] = val;
  }
  // Observability (opt-in): mirror the bash resolver's LOKI_SDK_MODE_DEBUG line
  // so an operator can see what one switch turned on. Off by default.
  if (env["LOKI_SDK_MODE_DEBUG"] === "1") {
    process.stderr.write(`loki: SDK mode=${mode} -> judges on, loop=${env[LOOP_VAR] ?? "0"}\n`);
  }
  return mode;
}
