// CLI consolidation (Phase A): deprecated-alias back-compat contract (Bun side).
//
// Mirrors the bash `_deprecated_alias` helper (autonomy/loki) byte-for-byte so
// a deprecated alias behaves identically whether it routes through Bun or bash.
// An old command token forwards 1:1 to its canonical command and prints exactly
// ONE pointer line to STDERR. The line is suppressed whenever an explicit
// machine-output flag (--json, -q, --quiet) is present, so JSON consumers and
// callers that capture combined 2>&1 see a clean stream. Non-TTY stdout is
// intentionally NOT a suppression trigger.
//
// This is only reached for Bun-native alias tokens (currently `stats`). The
// `report` noun is bash-only, so `report session` never re-enters this path --
// emitting here for the bare `stats` token cannot double-fire.

const MACHINE_FLAGS = new Set(["--json", "-q", "--quiet"]);

export function deprecatedAliasShouldSuppress(args: readonly string[]): boolean {
  for (const a of args) {
    if (MACHINE_FLAGS.has(a)) return true;
  }
  return false;
}

// Emit the standardized one-line deprecation pointer to stderr (suppressed
// under machine-output flags). Telemetry is intentionally NOT fired here: the
// bash CLI's main() already emits the cli_command product-analytics event, and
// the Bun shim (bin/loki) fires its own copy for Bun-routed commands, so the
// alias telemetry is covered by the existing dual-route emit without a
// double-count.
export function emitDeprecatedAlias(
  oldName: string,
  newName: string,
  args: readonly string[],
): void {
  if (deprecatedAliasShouldSuppress(args)) return;
  process.stderr.write(
    `note: 'loki ${oldName}' is now 'loki ${newName}'. The old form still works.\n`,
  );
}
