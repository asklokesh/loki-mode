#!/usr/bin/env node
// npm postinstall: repoint stale skill links (FC-30) and install shell completions. Must never fail the install.
try {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  spawnSync("bash", ["-c", '. "$1/autonomy/lib/skill-link-heal.sh" && loki_skill_link_heal "$1"', "_", root], { stdio: ["ignore", "ignore", "inherit"], timeout: 10000 });
  if (!process.env.CI && process.env.LOKI_NO_COMPLETIONS !== "1") {
    spawnSync(path.join(__dirname, "loki"), ["completion", "--postinstall"], { stdio: "ignore", timeout: 20000 });
  }
} catch (e) {
  // ignore: completions are a convenience
}
process.exit(0);
