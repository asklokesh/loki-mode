// verify-pr only: the sandbox-side wrapper that records what a Python test check loads. A module of its own because the engine10 core is at its line cap, and testmap.ts cannot import contrib/ (RG-06) or verify_pr_f2p.ts (which imports testmap).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";
/** Sandbox wrapper for a Python test check (verify-pr): writes the load recorder from scripts/vpr-pytest-boot into a fresh mktemp dir (removed on exit), puts it first on PYTHONPATH and loads its plugin ahead of any ini plugin. The recorder writes to fd 9, the append-only hits pipe the sandbox reads from outside the check (the HITS_TOKEN no-op in the first line asks for it). */
export const HITS_TOKEN = "__LOKI_HITS__";
export const pytestBoot = (cmd: string): string => {
  const f = (n: string, to: string) => `cat >"$B/${to}" <<'LOKI_VPR_PY'\n${readFileSync(join(REPO_ROOT, "scripts/vpr-pytest-boot", n), "utf8")}LOKI_VPR_PY`;
  return [`: ${HITS_TOKEN}`, 'B=$(mktemp -d "${TMPDIR:-/tmp}/loki-vpr.XXXXXX") || exit 125', 'trap \'rm -rf "$B"\' EXIT', f("loki_vpr_boot.py", "loki_vpr_boot.py"), f("loki_vpr_plugin.py", "loki_vpr_plugin.py"), f("loki_vpr_site.py", "sitecustomize.py"),
    'export LOKI_VPR_ROOT="$(pwd -P)" PYTHONPATH="$B${PYTHONPATH:+:$PYTHONPATH}" PYTEST_ADDOPTS="-p loki_vpr_plugin ${PYTEST_ADDOPTS-}"', cmd].join("\n") + "\n";
};
