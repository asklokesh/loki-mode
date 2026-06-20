// `loki proof` - inspect and share proof-of-run artifacts (R1, SLICE B).
//
// Bun-native parity for the bash cmd_proof (autonomy/loki). Reads the same
// .loki/proofs/<id>/{proof.json,index.html} artifacts written by the
// generator (autonomy/lib/proof-generator.py). The proof.json schema is
// frozen in the R1 spec; reads are tolerant of missing keys (early/degraded
// proofs) and default to "-".
//
// Subcommands:
//   loki proof list            -- enumerate proofs (run_id, date, verdict, cost, files)
//   loki proof show <id>       -- pretty-print proof.json
//   loki proof open <id>       -- open index.html in a browser
//   loki proof share <id>      -- publish index.html as a gist (opt-in + redaction preview)
//
// `share` shells out to `gh gist create` after a redaction-preview
// confirmation, mirroring the bash _loki_gist_upload helper.
//
// Routing note: the bin/loki shim allowlist DOES include "proof" (bin/loki
// line ~119), so when bun is installed a real `loki proof` invocation routes
// to this Bun implementation -- it is the live route. The bash cmd_proof
// (autonomy/loki) remains the fallback for systems without bun and for the
// LOKI_LEGACY_BASH=1 escape hatch, so this port is kept parity-correct with
// it (see loki-ts/tests/commands/proof.test.ts for the bash-vs-Bun gate).

import { existsSync, readdirSync, readFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { lokiDir, REPO_ROOT } from "../util/paths.ts";
import { run } from "../util/shell.ts";
import { BOLD, CYAN, GREEN, NC, RED, YELLOW } from "../util/colors.ts";
import { tierGate } from "../util/tier.ts";

const HELP = `${BOLD}loki proof${NC} - inspect and share proof-of-run artifacts

Usage: loki proof <subcommand> [args]

Subcommands:
  list                 List proof-of-run artifacts in .loki/proofs/
  show <id>            Pretty-print .loki/proofs/<id>/proof.json
  verify <id>          Re-check a receipt against your code (tamper + drift)
  open <id>            Open .loki/proofs/<id>/index.html in a browser
  share <id>           Publish the proof page as a GitHub Gist (opt-in)

Options for 'share':
  --yes                Skip the redaction-preview confirmation prompt
  --private            Create a secret gist (default: public)
  --hosted             Publish to LOKI_HOSTED_ENDPOINT (open-core seam; no official backend yet)

Proofs are generated automatically at run completion (LOKI_PROOF=0 to opt out).
`;

type ProofJson = Record<string, unknown>;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return v === undefined || v === null ? "-" : String(v);
}

function proofsDir(): string {
  return join(lokiDir(), "proofs");
}

function readProof(id: string): ProofJson | null {
  const pj = join(proofsDir(), id, "proof.json");
  if (!existsSync(pj)) return null;
  try {
    return JSON.parse(readFileSync(pj, "utf8")) as ProofJson;
  } catch {
    return {};
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function listProofs(): number {
  const dir = proofsDir();
  if (!existsSync(dir)) {
    process.stdout.write(`${YELLOW}No proofs found.${NC} Run 'loki start' to generate one.\n`);
    return 0;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    entries = [];
  }
  const rows: string[] = [];
  for (const id of entries) {
    const pj = join(dir, id, "proof.json");
    if (!existsSync(pj)) continue;
    let d: ProofJson = {};
    try {
      d = JSON.parse(readFileSync(pj, "utf8")) as ProofJson;
    } catch {
      d = {};
    }
    const runId = str(d["run_id"]);
    const gen = str(d["generated_at"]);
    // The honest verdict lives in honesty.headline (VERIFIED / VERIFIED WITH
    // GAPS / NOT VERIFIED). Fall back to the legacy council.final_verdict for
    // older proofs that predate the honesty block.
    const headline = obj(d["honesty"])["headline"];
    const verdict = str(headline ?? obj(d["council"])["final_verdict"]);
    const cost = str(obj(d["cost"])["usd"]);
    const files = str(obj(d["files_changed"])["count"]);
    rows.push(
      `${pad(runId, 26)}  ${pad(gen, 20)}  ${pad(verdict, 18)}  ${pad(cost, 9)}  ${files}`,
    );
  }
  if (rows.length === 0) {
    process.stdout.write(`${YELLOW}No proofs found.${NC} Run 'loki start' to generate one.\n`);
    return 0;
  }
  process.stdout.write(
    `${pad("RUN_ID", 26)}  ${pad("GENERATED_AT", 20)}  ${pad("VERDICT", 18)}  ${pad("COST_USD", 9)}  FILES\n`,
  );
  for (const r of rows) process.stdout.write(`${r}\n`);
  return 0;
}

function showProof(id: string | undefined): number {
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 2;
  }
  const d = readProof(id);
  if (d === null) {
    process.stderr.write(`${RED}Proof not found: ${id}${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
  return 0;
}

async function openProof(id: string | undefined): Promise<number> {
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 2;
  }
  const html = join(proofsDir(), id, "index.html");
  if (!existsSync(html)) {
    process.stderr.write(`${RED}Proof page not found: ${id}/index.html${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  process.stdout.write(`${GREEN}Opening proof: ${html}${NC}\n`);
  // Try each opener in turn. Bun.spawn cannot run the `command -v` shell
  // builtin, so we probe by invoking the opener directly: a missing binary
  // surfaces as a spawn failure (caught) and we move to the next.
  for (const opener of ["open", "xdg-open", "start"]) {
    try {
      const r = await run([opener, html], { timeoutMs: 5000 });
      if (r.exitCode === 0) return 0;
    } catch {
      /* opener not present; try the next one */
    }
  }
  process.stdout.write("\nCould not detect browser opener.\n");
  process.stdout.write(`Please open in browser: ${html}\n`);
  return 0;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

// hostedPublishProof - R9 hosted proof-publish client stub (Bun parity for the
// bash _loki_hosted_publish_proof).
//
// Posts an ALREADY-REDACTED proof page to LOKI_HOSTED_ENDPOINT. There is NO
// official Loki hosted backend yet; this is a clean client seam an operator can
// point at their own endpoint. We never fabricate a hosted URL: on success we
// print the URL the endpoint returned (or the endpoint itself); on any failure
// we print an honest error and return non-zero.
async function hostedPublishProof(
  id: string,
  html: string,
  pj: string,
): Promise<number> {
  // Tier seam (no-op allow for OSS). Hosted publish is opt-in regardless; the
  // gate only emits honest notes for misconfigured non-OSS tiers.
  const gate = tierGate("hosted_publish");
  for (const note of gate.notes) process.stderr.write(`${note}\n`);

  const endpoint = process.env["LOKI_HOSTED_ENDPOINT"] || "";
  if (!endpoint) {
    process.stderr.write(`${YELLOW}Hosted publishing backend not available.${NC}\n`);
    process.stderr.write(
      "There is no official Loki hosted service yet (R9 ships the seam, not a live backend).\n",
    );
    process.stderr.write(
      "To publish to your own hosted endpoint, set LOKI_HOSTED_ENDPOINT to its URL.\n",
    );
    process.stderr.write(`Or publish to a GitHub Gist instead: loki proof share ${id}\n`);
    return 1;
  }

  // CREDIBILITY: we upload the file the generator already redacted (the same
  // bytes 'loki proof share' would put on a gist). If proof.json reports that
  // redaction was not applied, refuse -- never publish an unredacted artifact.
  const d = readProof(id);
  if (d) {
    const red = obj(d["redaction"]);
    // Fail CLOSED: refuse unless redaction is explicitly confirmed applied.
    // Absent/missing redaction metadata (an old or degraded proof whose HTML may
    // carry secrets) must NOT publish -- matches the bash route, which refuses
    // unless applied is truthy. Checking only `=== false` would let an undefined
    // value through and POST an unredacted artifact to the operator endpoint.
    if (red["applied"] !== true) {
      process.stderr.write(
        `${RED}Refusing to publish: proof redaction was not confirmed applied.${NC}\n`,
      );
      process.stderr.write(
        "Regenerate the proof (LOKI_PROOF=1) so the redactor runs, then retry.\n",
      );
      return 1;
    }
  }
  // pj is referenced for parity with the bash signature and future schema reads.
  void pj;

  process.stdout.write(`${BOLD}Publishing proof '${id}' to hosted endpoint${NC}\n`);
  process.stdout.write(`  endpoint: ${endpoint}\n`);
  process.stdout.write(`  payload:  ${html} (already redacted by the generator)\n\n`);

  let body: Buffer;
  try {
    body = await readFile(html);
  } catch {
    process.stderr.write(`${RED}Could not read proof page: ${html}${NC}\n`);
    return 1;
  }

  const headers: Record<string, string> = {
    "Content-Type": "text/html",
    "X-Loki-Proof-Id": id,
  };
  const licenseKey = process.env["LOKI_LICENSE_KEY"] || "";
  if (licenseKey) headers["Authorization"] = `Bearer ${licenseKey}`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
    });
  } catch (e) {
    process.stderr.write(
      `${RED}Failed to reach hosted endpoint: ${String((e as Error).message || e)}${NC}\n`,
    );
    process.stderr.write(
      `Check LOKI_HOSTED_ENDPOINT or publish to a gist: loki proof share ${id}\n`,
    );
    return 1;
  }

  const text = await resp.text();
  if (!resp.ok) {
    process.stderr.write(`${RED}Hosted endpoint returned HTTP ${resp.status}.${NC}\n`);
    if (text) {
      process.stderr.write("Response:\n");
      process.stderr.write(`${text.slice(0, 500)}\n`);
    }
    process.stderr.write(`Nothing was published. Or publish to a gist: loki proof share ${id}\n`);
    return 1;
  }

  // Accept any 2xx. The published URL comes from the endpoint response if it
  // returns one (a "url" or "public_url" field); else we report the endpoint.
  // We NEVER print a fabricated URL.
  let publishedUrl = "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const u = parsed["url"] ?? parsed["public_url"];
      if (typeof u === "string") publishedUrl = u;
    }
  } catch {
    /* response was not JSON; fall through to endpoint-only message */
  }
  if (publishedUrl) {
    process.stdout.write(`${GREEN}Published: ${publishedUrl}${NC}\n`);
  } else {
    process.stdout.write(
      `${GREEN}Published to ${endpoint} (HTTP ${resp.status}).${NC}\n`,
    );
    process.stdout.write(
      "The endpoint did not return a 'url' field; check your endpoint's response.\n",
    );
  }
  return 0;
}

async function shareProof(argv: readonly string[]): Promise<number> {
  let id = "";
  let skipConfirm = false;
  let visibility = "--public";
  let hosted = false;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") skipConfirm = true;
    else if (a === "--private") visibility = "";
    else if (a === "--public") visibility = "--public";
    else if (a === "--hosted") hosted = true;
    else if (a.startsWith("-")) {
      process.stderr.write(`${RED}Unknown option: ${a}${NC}\n`);
      return 1;
    } else id = a;
  }
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 2;
  }
  const html = join(proofsDir(), id, "index.html");
  if (!existsSync(html)) {
    process.stderr.write(`${RED}Proof page not found: ${id}/index.html${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  // R9 open-core hosted-publish seam. Only taken when the user explicitly
  // passes --hosted. The default gist path below stays unchanged for OSS users
  // (zero hosted backend required). We never silent-fall-back to gist here: the
  // user asked for hosted, so we POST to a configured LOKI_HOSTED_ENDPOINT or
  // print an honest "no endpoint configured" message and exit non-zero. We
  // never fabricate a hosted URL.
  if (hosted) {
    return hostedPublishProof(id, html, join(proofsDir(), id, "proof.json"));
  }
  const ghCheck = await run(["gh", "--version"], { timeoutMs: 5000 });
  if (ghCheck.exitCode !== 0) {
    process.stderr.write(`${RED}gh CLI not found${NC}\n`);
    process.stderr.write("Install the GitHub CLI to publish a proof:\n");
    process.stderr.write("  brew install gh        # macOS\n");
    process.stderr.write("  sudo apt install gh    # Ubuntu/Debian\n");
    process.stderr.write("  https://cli.github.com # Other platforms\n");
    return 1;
  }
  const ghAuth = await run(["gh", "auth", "status"], { timeoutMs: 10000 });
  if (ghAuth.exitCode !== 0) {
    process.stderr.write(`${RED}GitHub CLI not authenticated${NC}\n`);
    process.stderr.write("Run 'gh auth login' to authenticate, then try again.\n");
    return 1;
  }

  // Redaction preview. The generator already redacts the proof before
  // writing index.html; this is a transparency summary, not a second pass.
  const visLabel = visibility === "" ? "secret" : "public";
  process.stdout.write(
    `${BOLD}Publishing proof '${id}' as a ${visLabel} GitHub Gist${NC}\n\n`,
  );
  process.stdout.write("What will be shared:\n");
  process.stdout.write(`  - ${html}\n`);
  const d = readProof(id);
  if (d) {
    const cost = str(obj(d["cost"])["usd"]);
    const files = str(obj(d["files_changed"])["count"]);
    const verdict = str(obj(d["council"])["final_verdict"]);
    const red = obj(d["redaction"]);
    process.stdout.write(`  - cost.usd:        ${cost}\n`);
    process.stdout.write(`  - files_changed:   ${files}\n`);
    process.stdout.write(`  - council verdict: ${verdict}\n`);
    process.stdout.write(
      `  - redaction:       applied=${str(red["applied"])} rules_version=${str(red["rules_version"])} redactions_count=${str(red["redactions_count"])}\n`,
    );
  }
  process.stdout.write(
    `\n${YELLOW}Secrets, API keys, tokens, env values, and absolute paths have already been stripped by the generator.${NC}\n\n`,
  );

  if (!skipConfirm) {
    const ok = await confirm(`Publish this proof to a ${visLabel} gist? [y/N] `);
    if (!ok) {
      process.stdout.write("Aborted. Nothing was published.\n");
      return 0;
    }
  }

  // Copy to a temp file so the gist description matches the bash route and
  // we never hand gh a path inside .loki/.
  const dir = mkdtempSync(join(tmpdir(), "loki-proof-"));
  const tmpfile = join(dir, "index.html");
  copyFileSync(html, tmpfile);
  process.stdout.write("Uploading proof page...\n");
  const desc = `Loki Mode proof-of-run ${id}`;
  const args = ["gh", "gist", "create", tmpfile, "--desc", desc];
  // Match bash: empty visibility (--private) collapses to no flag.
  if (visibility !== "") args.push(visibility);
  const res = await run(args, { timeoutMs: 60000 });
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  if (res.exitCode !== 0) {
    process.stderr.write(`${RED}Failed to create gist${NC}\n`);
    process.stderr.write(`${res.stdout}${res.stderr}\n`);
    return 1;
  }
  process.stdout.write(`${GREEN}Shared: ${res.stdout.trim()}${NC}\n`);
  return 0;
}

// verifyProof - deterministic re-check of a receipt (tamper + drift), Bun parity
// for the bash `proof verify`. Both routes shell out to the SAME verifier
// (autonomy/lib/proof-verify.py) so there is one source of truth: it re-hashes
// the canonical proof (tamper) and re-derives the diff from the recorded base_sha
// vs live HEAD (drift). This is the "verify it yourself" path that makes the
// Evidence Receipt non-forgeable -- and it is the command `loki own` tells users
// to run, so it MUST exist on the default (Bun) route, not only the bash fallback.
// Exit 0 = clean, 1 = tamper/drift, 2 = unusable input.
async function verifyProof(id: string | undefined): Promise<number> {
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 2;
  }
  const pj = join(proofsDir(), id, "proof.json");
  if (!existsSync(pj)) {
    process.stderr.write(`${RED}Proof not found: ${id}${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  const verifier = resolve(REPO_ROOT, "autonomy", "lib", "proof-verify.py");
  if (!existsSync(verifier)) {
    process.stderr.write(`${RED}Verifier not found (autonomy/lib/proof-verify.py).${NC}\n`);
    return 2;
  }
  const target = process.env["TARGET_DIR"] || ".";
  // Shell out to the verifier and pass its report + exit code through verbatim
  // (0 clean / 1 tamper-drift / 2 unusable). run() captures, so we write the
  // captured streams back out; the verifier prints a JSON report on stdout.
  const r = await run(["python3", verifier, pj, target], { timeoutMs: 30000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
}

export async function runProof(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return sub === undefined ? 1 : 0;
  }

  switch (sub) {
    case "list":
      return listProofs();
    case "show":
      return showProof(rest[0]);
    case "verify":
      return verifyProof(rest[0]);
    case "open":
      return openProof(rest[0]);
    case "share":
      return shareProof(rest);
    default:
      process.stderr.write(`${RED}Unknown subcommand: ${sub}${NC}\n`);
      process.stderr.write("Run 'loki proof --help' for usage.\n");
      return 1;
  }
}
