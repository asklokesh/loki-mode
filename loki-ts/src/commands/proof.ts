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

import { existsSync, readdirSync, realpathSync, statSync, readFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { lokiDir, REPO_ROOT } from "../util/paths.ts";
import { run } from "../util/shell.ts";
import { safeGit } from "../util/safe_git.ts";
import { findIsolatedPython3 } from "../util/python.ts";
import { BOLD, CYAN, GREEN, NC, RED, YELLOW } from "../util/colors.ts";
import { tierGate } from "../util/tier.ts";
import { main as verifyRunMain, verifyReceipt } from "../engine10/verify_cmd.ts";
import { runIdGuard } from "../features/receipt_dsse.ts";
import { buildAuditBundle, buildReceiptBundle, commitsInRange, receiptsInRange } from "../util/receipt_bundle.ts";
import { runSecureScan } from "../util/secure_scan.ts";

const HELP = `${BOLD}loki proof${NC} - inspect and share proof-of-run artifacts

Usage: loki proof <subcommand> [args]

Subcommands:
  list [--json]        List proof-of-run artifacts in .loki/proofs/
  show <id> [--json]   Compact reviewer summary; --json prints the full proof.json
  verify <id>          Re-check a receipt against your code (tamper + drift)
                       [--jwks <url|file>] also checks its attestation; [--human]
                       Exit 0 clean, 1 tamper/drift or attestation FAILED/ABSENT,
                       2 could not check, 64 usage, 66 unknown id
  open <id>            Open .loki/proofs/<id>/index.html in a browser
  share <id>           Publish the proof page as a GitHub Gist (opt-in)
  md <id>              Paste-able Markdown for a PR comment or Slack
  badge <id>           Print a copy-paste "Verified by Loki" markdown badge
  bundle <run-id>      Write a portable receipt bundle for offline verification
                       [--out <dir>] (default ./loki-bundle-<run-id>)
  bundle --audit <from>..<to>
                       One .tgz with every run receipt whose head commit is in the range,
                       an index.csv (run_id,commit,verdict,date) and a verify.sh that
                       cross-checks the index against the signed receipts and prints key ids
                       (pin with --expect-kid)
                       [--out <file.tgz>] (default ./loki-audit-<from>..<to>.tgz). Evidence
                       export only; it makes no certification claim.

For a 'loki start' run with no .loki/proofs/<id>, badge, bundle and share read
.loki/runs/<id>/receipt.json. badge prints only when the signature verifies and
the receipt verdict is VERIFIED or ALREADY_SATISFIED; otherwise exit 1.

Options for 'share':
  --yes                Skip the redaction-preview confirmation prompt
  --public             Create a PUBLIC gist, visible to anyone with the URL
  --private            Create a secret gist (default: secret; accepted for compatibility)
  --hosted             Publish to LOKI_HOSTED_ENDPOINT (open-core seam; no official backend yet)
  --dry-run            Run the secret scan and list what would be published; publishes
                       nothing. Exit 0 clean, 1 when the scan blocks

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

function listProofsJson(dir: string): number {
  const out: Array<{ id: string; verdict: string | null; created: string | null }> = [];
  let names: string[] = [];
  try {
    names = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : [];
  } catch {
    names = [];
  }
  for (const id of names) {
    const d = readProof(id);
    if (d === null) continue;
    const verdict = obj(d["honesty"])["headline"] ?? obj(d["council"])["final_verdict"];
    const created = d["generated_at"];
    out.push({
      id,
      verdict: verdict === undefined || verdict === null ? null : String(verdict),
      created: created === undefined || created === null ? null : String(created),
    });
  }
  // Newest first; ISO timestamps sort lexically. Missing created sorts last.
  out.sort((a, b) => {
    const ca = a.created ?? "";
    const cb = b.created ?? "";
    if (ca !== cb) return ca < cb ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

function listProofs(asJson = false): number {
  const dir = proofsDir();
  if (asJson) return listProofsJson(dir);
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

async function showProof(args: readonly string[]): Promise<number> {
  const asJson = args.includes("--json");
  const id = args.find((a) => a !== "--json");
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 2;
  }
  const d = readProof(id);
  if (d === null) {
    // A 'loki start' run id has a sealed receipt, not a proof record: show it through the engine10 verifier.
    const rp = runReceiptPath(id);
    if (rp) {
      if (asJson) {
        process.stdout.write(readFileSync(rp, "utf8"));
        return 0;
      }
      return verifyRunMain([id]);
    }
    process.stderr.write(`${RED}Proof not found: ${id}${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
    return 0;
  }
  // Compact reviewer summary from the one shared implementation
  // (autonomy/lib/proof-verify.py; docs/PROOF-PASSPORT.md).
  const summarizer = resolve(REPO_ROOT, "autonomy", "lib", "proof-verify.py");
  const target = resolveVerifyRoot();
  const py = await findIsolatedPython3();
  if (!existsSync(summarizer) || target === null || !py) {
    process.stderr.write(
      `${YELLOW}Summary unavailable (verifier module, project tree or python3 missing).${NC} Use 'loki proof show ${id} --json' for the full record.\n`,
    );
    return 2;
  }
  const pj = join(proofsDir(), id, "proof.json");
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run([py, "-I", "-S", summarizer, "summary", pj, "--repo", target, "--loki-dir", lokiDir()], {
      timeoutMs: 30000,
    });
  } catch (e) {
    process.stderr.write(`${YELLOW}Summary unavailable (${String((e as Error).message || e)}).${NC}\n`);
    return 2;
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
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
  // Try each opener in turn, but only when browserOpenAllowed() says so.
  // Bun.spawn cannot run the `command -v` shell builtin, so we probe by
  // invoking the opener directly: a missing binary surfaces as a spawn
  // failure (caught) and we move to the next.
  if (browserOpenAllowed()) {
    for (const opener of ["open", "xdg-open", "start"]) {
      try {
        const r = await run([opener, html], { timeoutMs: 5000 });
        if (r.exitCode === 0) return 0;
      } catch {
        /* opener not present; try the next one */
      }
    }
  }
  process.stdout.write("\nBrowser not opened (headless, test, or no opener).\n");
  process.stdout.write(`Please open in browser: ${html}\n`);
  return 0;
}

// Mirror of loki_browser_allowed (autonomy/lib/browser-open.sh, S-103): never
// open a browser from tests, CI, or a non-TTY run. Keep the two in step.
export function browserOpenAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LOKI_NO_BROWSER === "1" || env.LOKI_NO_AUTO_OPEN === "1") return false;
  if (env.CI) return false;
  if (env.LOKI_TEST || env.BATS_VERSION || env.BATS_TEST_FILENAME || env.PYTEST_CURRENT_TEST) return false;
  return process.stdout.isTTY === true;
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
  // HLW-5: also print the shareable badge, linked to the published URL when the
  // endpoint returned one (else image-only -- never fabricate a hosted URL).
  printProofBadge(id, publishedUrl || undefined);
  return 0;
}

// renderProofBadge - HLW-5 shareable "Verified by Loki" Evidence Receipt badge.
//
// PURE + DISPLAY-ONLY. Given a proof's honesty.headline (read from the SAME
// redacted proof.json the share path uses), returns a copy-paste markdown badge
// whose color/text derive ONLY from the headline. This is NOT a trust-core or
// evidence-gate change: it renders what the honest headline already decided.
//
// ANTI-FAKE-GREEN (mirrors the R-HON-1 discipline in proof-pr.sh:13): green is
// produced ONLY when headline === "VERIFIED" exactly. Any other value -- amber,
// red, absent/empty, or an UNKNOWN non-empty string -- never renders green. An
// absent/empty or unrecognized headline returns null (no badge) rather than
// fabricating a verdict.
//
// The badge uses a shields.io static-badge image URL (no infra, no dependency).
// Note: shields.io is an EXTERNAL image host; rendering the badge fetches from
// img.shields.io. The badge image links to linkUrl (the shared gist/hosted URL)
// when one is supplied, so a click shows the receipt; with no link the badge is
// image-only.
export function renderProofBadge(
  headline: string | undefined | null,
  linkUrl?: string,
): string | null {
  const h = (headline ?? "").trim();
  // Exact-match table. Green ("brightgreen") is reachable ONLY from "VERIFIED".
  let message = "";
  let color = "";
  if (h === "VERIFIED") {
    message = "Verified by Loki";
    color = "brightgreen";
  } else if (h === "VERIFIED WITH GAPS") {
    message = "Verified with gaps";
    color = "yellow";
  } else if (h === "ALREADY SATISFIED") {
    message = "Already satisfied";
    color = "blue";
  } else if (h === "NOT VERIFIED") {
    message = "Not verified";
    color = "red";
  } else {
    // Absent, empty, or an unknown non-empty headline: emit NO badge. Never
    // default an unrecognized value to green (or any color) -- honesty over a
    // pretty artifact.
    return null;
  }
  // shields.io static badge: /badge/<label>-<message>-<color>. The color segment
  // is the load-bearing honesty signal and is derived solely from the headline
  // above. URL-encode the label/message so spaces render (%20); encode literal
  // dashes as `--` per the shields path grammar (none of our three messages
  // contain a dash, but keep the encoder correct if the strings ever change).
  const enc = (s: string): string => encodeURIComponent(s.replace(/-/g, "--"));
  const label = "Loki";
  const badgeUrl = `https://img.shields.io/badge/${enc(label)}-${enc(message)}-${color}`;
  const alt = "Verified by Loki";
  const img = `![${alt}](${badgeUrl})`;
  return linkUrl ? `[${img}](${linkUrl})` : img;
}

// printProofBadge - shared output helper. Prints the badge (with an honest note
// when there is no verifiable headline) so the gist/hosted/badge paths render
// identically. Reads honesty.headline from the redacted proof.json (readProof).
function printProofBadge(id: string, linkUrl?: string): void {
  const d = readProof(id);
  const headline = d ? str(obj(d["honesty"])["headline"]) : "";
  // str() maps absent to "-"; treat that as no headline for the badge.
  const md = renderProofBadge(headline === "-" ? "" : headline, linkUrl);
  if (md) {
    process.stdout.write(`\n${BOLD}Shareable badge${NC} (copy-paste markdown):\n`);
    process.stdout.write(`${md}\n`);
  } else {
    process.stdout.write(
      `\n${YELLOW}No badge:${NC} this proof has no verifiable headline, so no badge is shown (no fake-green).\n`,
    );
  }
}

// mdProof - `loki proof md <id>`: paste-able Markdown for a PR comment.
//
// DELEGATES to render_evidence_receipt_md in autonomy/lib/proof-pr.sh rather
// than reimplementing the layout here. That renderer already produces the PR
// body; a second implementation in TypeScript would drift, and the drift would
// surface as a PR body and a pasted summary disagreeing about the same run.
//
// This route is the DEFAULT one users hit. `md` shipped on the bash route in
// v8.6.0 and was unreachable here -- `loki proof md` answered "Unknown
// subcommand" for anyone who had not set LOKI_LEGACY_BASH=1.
async function mdProof(id: string | undefined): Promise<number> {
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 2;
  }
  const proofPath = join(lokiDir(), "proofs", id, "proof.json");
  if (!existsSync(proofPath)) {
    const rp = runReceiptPath(id);
    if (rp) {
      const { md, why } = await runBadgeMd(rp);
      if (!md) {
        process.stderr.write(`${RED}No markdown:${NC} ${why}\n`);
        return 1;
      }
      process.stdout.write(`${md}\n`);
      return 0;
    }
    process.stderr.write(`${RED}Proof not found: ${id}${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  const lib = join(REPO_ROOT, "autonomy", "lib", "proof-pr.sh");
  if (!existsSync(lib)) {
    process.stderr.write(`${RED}Renderer not found: ${lib}${NC}\n`);
    return 3;
  }
  const r = spawnSync(
    "bash",
    ["-c", `source ${JSON.stringify(lib)} && render_evidence_receipt_md ${JSON.stringify(proofPath)}`],
    { env: { ...process.env }, encoding: "utf8" },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0 && r.stderr) process.stderr.write(r.stderr);
  return r.status === 0 ? 0 : 1;
}

// badgeProof - `loki proof badge <id>`: print the shareable badge markdown only,
// nothing published. Useful for pasting a badge that links to an already-shared
// receipt (or an image-only badge with no link).
async function badgeProof(id: string | undefined): Promise<number> {
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 2;
  }
  const d = readProof(id);
  if (d === null) {
    const rp = runReceiptPath(id);
    if (rp) return printRunBadge(rp);
    process.stderr.write(`${RED}Proof not found: ${id}${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  printProofBadge(id);
  return 0;
}

// A 'loki start' (engine10) run keeps its sealed receipt at .loki/runs/<id>/receipt.json
// and never writes .loki/proofs/<id>. Returns that path only for a safe id.
function runReceiptPath(id: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..")) return null;
  const p = join(lokiDir(), "runs", id, "receipt.json");
  return existsSync(p) ? p : null;
}

// Badge text for a run receipt. Green needs BOTH the signature check (verifyReceipt) and the
// receipt's own verdict to say VERIFIED; nothing else earns a badge.
async function runBadgeMd(receiptPath: string, linkUrl?: string): Promise<{ md: string | null; why: string }> {
  const bound = runIdGuard(receiptPath, basename(dirname(receiptPath))); // same run-id binding as loki verify: a copied receipt earns no badge
  if (bound) return { md: null, why: `TAMPERED (${bound})` };
  const v = await verifyReceipt(receiptPath);
  let verdict = "";
  try {
    verdict = String((JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>)["verdict"] ?? "");
  } catch {
    /* unreadable receipt: verifyReceipt already reports it */
  }
  const headline =
    v.verdict === "VERIFIED" && verdict === "VERIFIED" ? "VERIFIED"
    : v.verdict === "VERIFIED" && verdict === "ALREADY_SATISFIED" ? "ALREADY SATISFIED"
    : "";
  const md = headline ? renderProofBadge(headline, linkUrl) : null;
  return { md, why: `signature check ${v.verdict}${v.reasons.length ? ` (${v.reasons.join("; ")})` : ""}, receipt verdict ${verdict || "unknown"}` };
}

async function printRunBadge(receiptPath: string): Promise<number> {
  const { md, why } = await runBadgeMd(receiptPath);
  if (!md) {
    process.stderr.write(`${RED}No badge:${NC} ${why}\n`);
    return 1;
  }
  process.stdout.write(`\n${BOLD}Shareable badge${NC} (copy-paste markdown):\n${md}\n`);
  return 0;
}

// `loki proof bundle <run-id> [--out <dir>]`: package a sealed run for verification elsewhere.
async function bundleProof(argv: readonly string[]): Promise<number> {
  let id = "";
  let out = "";
  let audit = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--audit") {
      audit = argv[++i] ?? "";
      if (!audit) {
        process.stderr.write(`${RED}--audit needs <from>..<to>.${NC}\n`);
        return 2;
      }
    } else if (a === "--out") {
      out = argv[++i] ?? "";
      if (!out) {
        process.stderr.write(`${RED}--out needs a directory.${NC}\n`);
        return 2;
      }
    } else if (a.startsWith("-")) {
      process.stderr.write(`${RED}Unknown option: ${a}${NC}\n`);
      return 1;
    } else id = a;
  }
  if (audit) {
    if (id) {
      process.stderr.write(`${RED}--audit takes a range, not a run id.${NC}\n`);
      return 2;
    }
    const range = commitsInRange(process.cwd(), audit);
    if (!range.ok) {
      process.stderr.write(`${RED}Audit bundle refused:${NC} ${range.error}\n`);
      return 2;
    }
    const outFile = resolve(out || join(process.cwd(), `loki-audit-${audit.replace(/[^A-Za-z0-9._-]/g, "_")}.tgz`));
    const { runs, unreadable } = receiptsInRange(join(lokiDir(), "runs"), range.commits);
    if (unreadable.length > 0) {
      process.stderr.write(`${RED}Audit bundle refused:${NC} ${unreadable.length} run receipt(s) cannot be read or mapped to a commit, so the archive would silently omit them:\n${unreadable.map((u) => `  ${u.runId}: ${u.reason}`).join("\n")}\nFix or move those run directories, then retry.\n`);
      return 1;
    }
    const r = await buildAuditBundle(runs, range.commits, outFile);
    if (!r.ok) {
      process.stderr.write(`${RED}Audit bundle refused:${NC} ${r.error}\n`);
      return 1;
    }
    process.stdout.write(`${GREEN}Audit archive written: ${r.outDir}${NC} (${runs.length} receipts)\nSigning key id: ${r.kid}\nExtract it and run verify.sh (needs the Loki CLI) to re-check each receipt. Pass --expect-kid <id> with a key id you got from the signer out of band;\nwithout a pinned key id the check proves the archive is internally consistent only.\n`);
    return 0;
  }
  if (!id) {
    process.stderr.write(`${RED}Missing run id.${NC}\n`);
    return 2;
  }
  const rp = runReceiptPath(id);
  if (!rp) {
    process.stderr.write(`${RED}Run receipt not found: .loki/runs/${id}/receipt.json${NC}\n`);
    return 1;
  }
  const outDir = resolve(out || join(process.cwd(), `loki-bundle-${id}`));
  const r = await buildReceiptBundle(dirname(rp), outDir);
  if (!r.ok) {
    process.stderr.write(`${RED}Bundle refused:${NC} ${r.error}\n`);
    return 1;
  }
  process.stdout.write(`${GREEN}Bundle written: ${r.outDir}${NC}\nVerify elsewhere: see ${join(r.outDir, "VERIFY.md")}\n`);
  return 0;
}

// gh present and authenticated, else print why and return false.
async function ghReady(): Promise<boolean> {
  const ghCheck = await run(["gh", "--version"], { timeoutMs: 5000 });
  if (ghCheck.exitCode !== 0) {
    process.stderr.write(`${RED}gh CLI not found${NC}\n`);
    process.stderr.write("Install the GitHub CLI to publish a proof:\n");
    process.stderr.write("  brew install gh        # macOS\n");
    process.stderr.write("  sudo apt install gh    # Ubuntu/Debian\n");
    process.stderr.write("  https://cli.github.com # Other platforms\n");
    return false;
  }
  const ghAuth = await run(["gh", "auth", "status"], { timeoutMs: 10000 });
  if (ghAuth.exitCode !== 0) {
    process.stderr.write(`${RED}GitHub CLI not authenticated${NC}\n`);
    process.stderr.write("Run 'gh auth login' to authenticate, then try again.\n");
    return false;
  }
  return true;
}

// share for a run with no proof page: gist ONLY the bundle files (never the key or .loki tree).
async function shareRun(id: string, receiptPath: string, skipConfirm: boolean, visibility: string, dryRun = false): Promise<number> {
  if (!dryRun && !(await ghReady())) return 1;
  const dir = mkdtempSync(join(tmpdir(), "loki-proof-"));
  try {
    const bdir = join(dir, "bundle");
    const b = await buildReceiptBundle(dirname(receiptPath), bdir);
    if (!b.ok) {
      process.stderr.write(`${RED}Share refused:${NC} ${b.error}\n`);
      return 1;
    }
    const files = ["receipt.json", "events.jsonl", "pubkey.jwk", "VERIFY.md"].map((f) => join(bdir, f));
    const scan = await runSecureScan(bdir, { secretsEverywhere: true });
    if (!scan.ok || scan.findings.length > 0) {
      process.stderr.write(`${RED}Share refused:${NC} redaction scan ${scan.ok ? `found ${scan.findings.length} finding(s)` : `failed (${scan.error ?? "unknown"})`}\n`);
      for (const f of scan.findings) process.stderr.write(`  - ${f.file}:${f.line} ${f.rule}\n`);
      return 1;
    }
    if (dryRun) {
      process.stdout.write(`${BOLD}Dry run: run '${id}' bundle${NC}\n\nWould publish:\n`);
      for (const f of ["receipt.json", "events.jsonl", "pubkey.jwk (public key only)", "VERIFY.md"]) process.stdout.write(`  - ${f}\n`);
      process.stdout.write(`  - redaction scan: 0 findings\n\nDry run: nothing was published.\n`);
      return 0;
    }
    const visLabel = visibility === "" ? "secret" : "public";
    process.stdout.write(`${BOLD}Publishing run '${id}' bundle as a ${visLabel} GitHub Gist${NC}\n\nWhat will be shared:\n`);
    for (const f of ["receipt.json", "events.jsonl", "pubkey.jwk (public key only)", "VERIFY.md"]) process.stdout.write(`  - ${f}\n`);
    process.stdout.write(`  - redaction scan: 0 findings\n\n`);
    if (!skipConfirm && !(await confirm(`Publish this bundle to a ${visLabel} gist? [y/N] `))) {
      process.stdout.write("Aborted. Nothing was published.\n");
      return 0;
    }
    const args = ["gh", "gist", "create", ...files, "--desc", `Loki Mode receipt bundle ${id}`];
    if (visibility !== "") args.push(visibility);
    if (visibility === "--public") process.stderr.write(`${YELLOW}Warning: this gist is PUBLIC and visible to anyone with the URL.${NC}\n`);
    const res = await run(args, { timeoutMs: 60000 });
    if (res.exitCode !== 0) {
      process.stderr.write(`${RED}Failed to create gist${NC}\n${res.stdout}${res.stderr}\n`);
      return 1;
    }
    const url = res.stdout.trim();
    process.stdout.write(`${GREEN}Shared: ${url}${NC}\n`);
    const { md } = await runBadgeMd(receiptPath, url);
    if (md) process.stdout.write(`\n${BOLD}Shareable badge${NC} (copy-paste markdown):\n${md}\n`);
    return 0;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// share --dry-run for a proof page: scan a copy of the exact file share would
// upload, print it, publish nothing. 1 when the scan blocks or fails.
async function dryRunProofPage(id: string, html: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "loki-proof-"));
  try {
    copyFileSync(html, join(dir, "index.html"));
    const scan = await runSecureScan(dir, { secretsEverywhere: true });
    if (!scan.ok || scan.findings.length > 0) {
      process.stderr.write(`${RED}Dry run: share would be refused:${NC} redaction scan ${scan.ok ? `found ${scan.findings.length} finding(s)` : `failed (${scan.error ?? "unknown"})`}\n`);
      for (const f of scan.findings) process.stderr.write(`  - ${f.file}:${f.line} ${f.rule}\n`);
      return 1;
    }
    process.stdout.write(`${BOLD}Dry run: proof '${id}'${NC}\n\nWould publish:\n  - ${html}\n  - redaction scan: 0 findings\n\nDry run: nothing was published.\n`);
    return 0;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

async function shareProof(argv: readonly string[]): Promise<number> {
  let id = "";
  let skipConfirm = false;
  let visibility = "";
  let hosted = false;
  let dryRun = false;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") skipConfirm = true;
    else if (a === "--private") visibility = "";
    else if (a === "--public") visibility = "--public";
    else if (a === "--hosted") hosted = true;
    else if (a === "--dry-run") dryRun = true;
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
    const rp = runReceiptPath(id);
    if (rp && (!hosted || dryRun)) return shareRun(id, rp, skipConfirm, visibility, dryRun);
    process.stderr.write(`${RED}Proof page not found: ${id}/index.html${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 1;
  }
  if (dryRun) return dryRunProofPage(id, html);
  // R9 open-core hosted-publish seam. Only taken when the user explicitly
  // passes --hosted. The default gist path below stays unchanged for OSS users
  // (zero hosted backend required). We never silent-fall-back to gist here: the
  // user asked for hosted, so we POST to a configured LOKI_HOSTED_ENDPOINT or
  // print an honest "no endpoint configured" message and exit non-zero. We
  // never fabricate a hosted URL.
  if (hosted) {
    return hostedPublishProof(id, html, join(proofsDir(), id, "proof.json"));
  }
  if (!(await ghReady())) return 1;

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
  if (visibility === "--public") process.stderr.write(`${YELLOW}Warning: this gist is PUBLIC and visible to anyone with the URL.${NC}\n`);
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
  const sharedUrl = res.stdout.trim();
  process.stdout.write(`${GREEN}Shared: ${sharedUrl}${NC}\n`);
  // HLW-5: also print the shareable "Verified by Loki" badge, linked to the gist.
  printProofBadge(id, sharedUrl);
  return 0;
}

/**
 * FC-29: the one place the Bun route decides which tree the verifier digests.
 * Mirrors loki_verify_root in autonomy/loki: TARGET_DIR, then the parent of an
 * absolute LOKI_DIR, then the cwd or repo top-level holding .loki. Returns null
 * (caller reports NOT CHECKED) for anything else, and for HOME or "/".
 */
export function resolveVerifyRoot(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string | null {
  const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
  const canon = (p: string): string => {
    const t = trim(p);
    try {
      return t ? realpathSync(t) : t;
    } catch {
      return t;
    }
  };
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  let d = env["TARGET_DIR"] ? trim(env["TARGET_DIR"] as string) : "";
  const ld = env["LOKI_DIR"] ?? "";
  if (!d && ld.startsWith("/") && existsSync(ld)) d = dirname(trim(ld));
  if (!d) {
    if (isDir(join(cwd, ".loki"))) {
      d = cwd;
    } else {
      let top = "";
      try {
        top = safeGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
      } catch {
        top = "";
      }
      if (top && isDir(join(top, ".loki"))) d = top;
    }
  }
  const home = env["HOME"] ? canon(env["HOME"] as string) : "";
  const cd = d ? canon(d) : "";
  if (!d || cd === "/" || (home && cd === home)) return null;
  return d;
}

// verifyProof - deterministic re-check of a receipt (tamper + drift), Bun parity
// for the bash `proof verify`. Both routes shell out to the SAME verifier
// (autonomy/lib/proof-verify.py) so there is one source of truth: it re-hashes
// the canonical proof (tamper) and re-derives the diff from the recorded base_sha
// vs live HEAD (drift). This is the "verify it yourself" path: it re-checks
// integrity + re-derives the diff, catching an inconsistent edit. It does NOT by
// itself make the receipt non-forgeable on the unsigned path (a hand-forger can
// rewrite facts and re-hash); neutral non-forgeability needs the signed record.
// It is the command `loki own` tells users to run, so it MUST exist on the
// default (Bun) route, not only the bash fallback.
// Exit 0 = clean, 1 = tamper/drift, 2 = unusable input, 64 = no id, 66 = not found.
async function verifyProof(id: string | undefined): Promise<number> {
  if (!id) {
    process.stderr.write(`${RED}Missing proof id.${NC} Use 'loki proof list'.\n`);
    return 64; // usage (docs/exit-codes.md); 2 means "could not check"
  }
  const pj = join(proofsDir(), id, "proof.json");
  if (!existsSync(pj)) {
    // Same verdict and exit codes as `loki verify <run-id>`.
    if (runReceiptPath(id)) return verifyRunMain([id]);
    process.stderr.write(`${RED}Proof not found: ${id}${NC}\n`);
    process.stderr.write("Use 'loki proof list' to see available proofs.\n");
    return 66; // input missing; 1 is reserved for tamper/drift
  }
  const verifier = resolve(REPO_ROOT, "autonomy", "lib", "proof-verify.py");
  if (!existsSync(verifier)) {
    process.stderr.write(`${RED}Verifier not found (autonomy/lib/proof-verify.py).${NC}\n`);
    return 2;
  }
  const target = resolveVerifyRoot();
  if (target === null) {
    process.stderr.write(
      `${YELLOW}NOT CHECKED${NC}: no project tree to verify against (exit 2).\n`,
    );
    return 2;
  }
  // Shell out to the verifier and pass its report + exit code through verbatim
  // (0 clean / 1 tamper-drift / 2 unusable). run() captures, so we write the
  // captured streams back out; the verifier prints a JSON report on stdout.
  // -I -S: PYTHON* env, the cwd (the checkout under verification), a committed
  // sitecustomize.py and a user-site .pth must not load code here (S-205).
  const py = await findIsolatedPython3();
  if (!py) {
    process.stderr.write(
      `${YELLOW}NOT CHECKED: no python3 passed the isolation probe (-I -S). Nothing was verified (exit 2).${NC}\n`,
    );
    return 2;
  }
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run([py, "-I", "-S", verifier, pj, target], { timeoutMs: 30000 });
  } catch (e) {
    // python3 missing or unspawnable: nothing was checked, so 2, not the
    // uncaught-exception 1 that reads as "tampered".
    process.stderr.write(
      `${YELLOW}NOT CHECKED: could not run the verifier (${String((e as Error).message || e)}).${NC}\n`,
    );
    return 2;
  }
  // Killed by a signal (the 30s timeout sends SIGTERM, then SIGKILL): the
  // verifier never reached a verdict, so this is NOT CHECKED (2). Passing the
  // raw 128+N through (143, 137) left the result unclassified. Partial stdout
  // is dropped so a machine consumer never parses a truncated report.
  if (r.exitCode > 128) {
    if (r.stderr) process.stderr.write(r.stderr);
    process.stderr.write(
      `${YELLOW}NOT CHECKED: the verifier was killed (exit ${r.exitCode}; timed out after 30s or signalled). Nothing was verified (exit 2).${NC}\n`,
    );
    return 2;
  }
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
      return listProofs(rest.includes("--json"));
    case "show":
      return showProof(rest);
    case "verify":
      // Any flag (--jwks, --human, in any position) goes to the bash CLI,
      // which owns flag parsing and the attestation check. verifyProof takes
      // only an id: before this, "verify <id> --jwks f" silently dropped the
      // key set and exited 0, and "verify --jwks f <id>" read the flag as the id.
      // A second positional goes there too, so bash rejects it (64) instead of
      // verifyProof silently checking only the first.
      if (rest.length > 1 || rest.some((a) => a.startsWith("-"))) {
        return proofFallthroughToBash(sub, rest);
      }
      return verifyProof(rest[0]);
    case "open":
      return openProof(rest[0]);
    case "share":
      return shareProof(rest);
    case "badge":
      return badgeProof(rest[0]);
    case "bundle":
      return bundleProof(rest);
    case "md":
      return mdProof(rest[0]);
    default:
      // DELEGATE, do not reject. The bash CLI owns the full `loki proof`
      // surface and grows subcommands the TS runtime has not implemented --
      // `phases` and `releases` shipped in 9.12.0 and were unreachable through
      // bin/loki, which is the entry point npm users actually get. Rejecting
      // here made a command that exists report "Unknown subcommand".
      //
      // Delegation keeps bash the single source of truth for what the surface
      // IS, so a new subcommand works through both entry points the moment it
      // is added, rather than requiring a matching TS arm nobody remembers.
      return proofFallthroughToBash(sub, rest);
  }
}

// Exit code when the bash CLI never gave one (not found, spawn failed, killed
// by a signal). For verify, 1 means "tampered", so an unmeasured result is 2
// (could not check); other subcommands have no tamper meaning and keep 1.
export function noBashResultCode(sub: string): number {
  // verify and chain are verifiers: no result means could not check (2),
  // never 1 (tampered / a stage failed).
  return sub === "verify" || sub === "chain" ? 2 : 1;
}

// Delegate an unrecognised `loki proof` subcommand to the bash CLI, which owns
// the full surface. Returns the child's exit code so a real failure stays a
// real failure rather than being flattened to 0.
function proofFallthroughToBash(sub: string, rest: string[]): number {
  const here = new URL(".", import.meta.url).pathname;
  // dist/loki.js sits at loki-ts/dist/, src at loki-ts/src/commands/; walk up
  // until autonomy/loki is found so both layouts resolve.
  let dir = here;
  let bashCli = "";
  for (let i = 0; i < 6; i++) {
    const candidate = `${dir}/../autonomy/loki`.replace(/\/+/g, "/");
    try {
      if (require("node:fs").existsSync(candidate)) { bashCli = candidate; break; }
    } catch { /* fall through to the next parent */ }
    dir = `${dir}/..`;
  }
  if (!bashCli) {
    if (sub === "verify") {
      process.stderr.write(
        `${YELLOW}NOT CHECKED: verify flags need the bash CLI (autonomy/loki), which was not found.${NC}\n`,
      );
    } else {
      process.stderr.write(`${RED}Unknown subcommand: ${sub}${NC}\n`);
      process.stderr.write("Run 'loki proof --help' for usage.\n");
    }
    return noBashResultCode(sub);
  }
  // env is explicit: Bun's spawnSync does not pass on runtime edits to
  // process.env (LOKI_DIR / TARGET_DIR set in-process would be lost).
  const r = spawnSync("bash", [bashCli, "proof", sub, ...rest], {
    stdio: "inherit",
    env: process.env,
  });
  if (typeof r.status === "number") return r.status;
  if (sub === "verify") {
    process.stderr.write(
      `${YELLOW}NOT CHECKED: the verifier ended without an exit code (${r.signal ?? r.error?.message ?? "unknown"}).${NC}\n`,
    );
  }
  return noBashResultCode(sub);
}
