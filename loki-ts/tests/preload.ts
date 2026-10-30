// E-154: no bun test may write the real ~/.loki/keys. Default the signing key
// file to a throwaway dir unless the caller already set one.
// E-154b: bun test never fires process "exit", so cleanup hangs off a bun:test
// afterAll; the dir is removed again (idempotent) after every file.
import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { registerContrib } from "../src/contrib/index.ts";
import { RECEIPT_SIGNER_BASENAME } from "../src/util/receipt_signer.ts";

// PG-64: afterAll is not reached when bun stops early (`--bail`, a `timeout` SIGTERM) and nothing runs after SIGKILL. Every dir this
// preload creates gets an owner marker holding this process's pid. Exit and signal handlers remove the dirs; the next run reaps only
// dirs that carry a marker whose pid is dead and whose marker is older than REAP_AGE_MS. Unmarked dirs are never touched.
const OWNER_MARKER = ".loki-test-owner";
const REAP_AGE_MS = 10 * 60 * 1000;
const ownedDirs = new Set<string>();
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
export function reapStaleTestDirs(root: string = tmpdir(), now: number = Date.now()): string[] {
  const reaped: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return reaped;
  }
  for (const name of names) {
    if (!name.startsWith("loki-test-home-") && !name.startsWith("loki-test-key-")) continue;
    const dir = join(root, name);
    const marker = join(dir, OWNER_MARKER);
    try {
      const pid = Number(readFileSync(marker, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) continue;
      if (now - statSync(marker).mtimeMs < REAP_AGE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      reaped.push(dir);
    } catch {
      // no marker or unreadable: not ours, leave it
    }
  }
  return reaped;
}
const markOwned = (dir: string): void => {
  ownedDirs.add(dir);
  writeFileSync(join(dir, OWNER_MARKER), `${process.pid}\n`);
};
const removeOwned = (): void => {
  for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true });
};
process.on("exit", removeOwned);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    removeOwned();
    process.exit(128 + (sig === "SIGTERM" ? 15 : sig === "SIGINT" ? 2 : 1));
  });
}
reapStaleTestDirs();

// D91: fill core's hook slots from contrib/, as src/cli.ts does at startup.
registerContrib();

// FC-01: the Project Model is ON by default in production; tests with a fake session runner opt out so discovery does not add a session. Tests of the default delete this.
if (process.env["LOKI_E10_PROJECT_MODEL"] === undefined) process.env["LOKI_E10_PROJECT_MODEL"] = "0";

// C2-F: runs ship to a discovered local Control Plane by default; no test may reach a developer's live instance.
if (process.env["LOKI_CONTROL"] === undefined) process.env["LOKI_CONTROL"] = "0";

// FC-07 / D86: no bun test may touch the real ~/.loki (control, dashboard registry, keys,
// answers) or ~/.gitconfig. HOME becomes a run-owned temp dir unless a parent entry point
// (run-all-tests.sh, local-ci.sh) already isolated it. The real HOME stays readable as
// LOKI_REAL_HOME, and toolchain homes stay pinned so nothing re-downloads.
if (process.env["LOKI_HERMETIC_HOME"] === undefined || process.env["HOME"] !== process.env["LOKI_HERMETIC_HOME"]) {
  // Never trust an inherited LOKI_REAL_HOME: HOME is not hermetic here, so HOME is the real home.
  const realHome = process.env["HOME"] ?? "";
  if (realHome) {
    process.env["LOKI_REAL_HOME"] = realHome;
    process.env["BUN_INSTALL"] ??= join(realHome, ".bun");
    process.env["CARGO_HOME"] ??= join(realHome, ".cargo");
    process.env["RUSTUP_HOME"] ??= join(realHome, ".rustup");
    process.env["GOPATH"] ??= join(realHome, "go");
    process.env["npm_config_cache"] ??= join(realHome, ".npm");
    const hermetic = mkdtempSync(join(tmpdir(), "loki-test-home-"));
    const seedHome = (): void => {
      mkdirSync(hermetic, { recursive: true, mode: 0o700 });
      writeFileSync(join(hermetic, ".gitconfig"), "[user]\n\tname = loki-test\n\temail = loki-test@example.invalid\n");
      markOwned(hermetic);
    };
    seedHome();
    process.env["LOKI_HERMETIC_HOME"] = hermetic;
    process.env["HOME"] = hermetic;
    process.env["GIT_CONFIG_GLOBAL"] = join(hermetic, ".gitconfig");
    // Same lifecycle as the key dir below: removed after every file, recreated before the next.
    beforeAll(seedHome);
    afterAll(() => {
      rmSync(hermetic, { recursive: true, force: true });
    });
  }
}

if (!process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-test-key-"));
  markOwned(dir);
  process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(dir, RECEIPT_SIGNER_BASENAME);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

// FC-TEST-TIMEOUT-OVERRIDES-CLI: the one place a test file sets its time budget. A file-level setDefaultTimeout literal
// beats the `bun test --timeout` flag (which bun does not expose to the process) and ignores load. This scales the base by
// machine load: factor = clamp(ceil(2 * load1 / cpus), 1, 10). Operator knobs: LOKI_TEST_TIMEOUT_SCALE (positive number,
// capped at 10) replaces the factor; LOKI_TEST_TIMEOUT_MS is a floor that wins when larger.
export function loadAwareTimeoutMs(
  baseMs: number,
  env: { load1?: number; cpuCount?: number; scale?: string; floorMs?: string } = {},
): number {
  const load1 = env.load1 ?? loadavg()[0] ?? 0;
  const cpuCount = Math.max(1, env.cpuCount ?? cpus().length);
  const override = Number(env.scale ?? process.env["LOKI_TEST_TIMEOUT_SCALE"]);
  const factor = Number.isFinite(override) && override > 0 ? Math.min(10, override) : Math.min(10, Math.max(1, Math.ceil((2 * load1) / cpuCount)));
  const floor = Number(env.floorMs ?? process.env["LOKI_TEST_TIMEOUT_MS"]);
  return Math.max(Math.round(baseMs * factor), Number.isFinite(floor) && floor > 0 ? floor : 0);
}
export const setLoadAwareTimeout = (baseMs: number): void => setDefaultTimeout(loadAwareTimeoutMs(baseMs));

// The global default for files with no opt-in is NOT set here. Measured on bun 1.3.13: a preload-time setDefaultTimeout (also
// inside beforeAll or beforeEach) reaches only one file of a multi-file `bun test`; every other file keeps the bunfig/CLI value.
// So the global default is the `--timeout` the test script in package.json passes (5000ms times LOKI_TEST_TIMEOUT_SCALE, which
// falls back to 3 unless it is a positive integer, and is capped at 10); bunfig.toml sets no timeout, and a bare `bun test` gets bun's own 5000ms. Files that need more call setLoadAwareTimeout in the file itself.
