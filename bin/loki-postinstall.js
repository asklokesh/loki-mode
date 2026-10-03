#!/usr/bin/env node
// npm postinstall: install shell completions. Must never fail the install.
try {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  if (!process.env.CI && process.env.LOKI_NO_COMPLETIONS !== "1") {
    spawnSync(path.join(__dirname, "loki"), ["completion", "--postinstall"], { stdio: "ignore", timeout: 20000 });
  }
} catch (e) {
  // ignore: completions are a convenience
}
process.exit(0);
