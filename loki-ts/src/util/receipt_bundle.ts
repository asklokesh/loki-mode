// TEN-ADOPTION-02: package a sealed run as a self-contained directory a third party can re-verify with the Loki CLI.
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { computeReceiptHash, verifyReceipt } from "../engine10/verify_cmd.ts";
import { kidOf, loadSigningKey } from "./receipt_signer.ts";
import { safeGitSpawn, tokenFreeEnv } from "./safe_git.ts";
import { isEnvelope, runIdGuard } from "../features/receipt_dsse.ts";

export type BundleResult = { ok: true; outDir: string; kid: string } | { ok: false; error: string };

export const VERIFY_COMMAND = "loki verify --pubkey pubkey.jwk receipt.json";

/** Writes receipt.json, events.jsonl, pubkey.jwk (public half only) and VERIFY.md into outDir.
 *  Refuses, writing nothing, unless the run's receipt is signed and verifies locally against the signer's public key. */
export async function buildReceiptBundle(runDir: string, outDir: string): Promise<BundleResult> {
  const receiptPath = join(runDir, "receipt.json"), eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(receiptPath)) return { ok: false, error: `no receipt.json in ${runDir}` };
  const bound = runIdGuard(receiptPath, basename(runDir)); // same run-id binding as loki verify: a receipt copied under another run id is not bundled
  if (bound) return { ok: false, error: `receipt is TAMPERED: ${bound}; only a locally VERIFIED signed receipt can be bundled` };
  const priv = loadSigningKey(false);
  if (!priv) return { ok: false, error: "no receipt signing key on this machine; cannot publish a verifying public key" };
  const pub = createPublicKey(priv), kid = kidOf(pub);
  const v = await verifyReceipt(receiptPath, { pubkey: pub });
  if (v.verdict !== "VERIFIED") return { ok: false, error: `receipt is ${v.verdict}${v.reasons.length ? `: ${v.reasons.join("; ")}` : ""}; only a locally VERIFIED signed receipt can be bundled` };
  if (!existsSync(eventsPath)) return { ok: false, error: `events.jsonl missing in ${runDir}` };
  if (existsSync(outDir) && readdirSync(outDir).length > 0) return { ok: false, error: `${outDir} already exists and is not empty; refusing to overwrite` };
  const { kty, crv, x } = pub.export({ format: "jwk" });
  const stage = `${outDir}.tmp-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    copyFileSync(receiptPath, join(stage, "receipt.json"));
    copyFileSync(eventsPath, join(stage, "events.jsonl"));
    // Files verify reads beside the receipt: evidence screenshots and the group/ unit tree.
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { evidence_screens?: { path?: unknown }[] };
    for (const s of Array.isArray(receipt.evidence_screens) ? receipt.evidence_screens : []) {
      if (typeof s?.path !== "string") continue;
      const rel = normalize(s.path);
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      copyFileSync(join(runDir, rel), join(stage, rel));
    }
    if (existsSync(join(runDir, "group"))) cpSync(join(runDir, "group"), join(stage, "group"), { recursive: true });
    writeFileSync(join(stage, "pubkey.jwk"), `${JSON.stringify({ kty, crv, x, kid, alg: "EdDSA", use: "sig" })}\n`);
    writeFileSync(join(stage, "VERIFY.md"), `# Verify this Loki receipt\n\nRun from this directory with the Loki CLI installed (npm i -g loki-mode); no account is needed.\n\n\`\`\`\n${VERIFY_COMMAND}\n\`\`\`\n\nExpected: VERIFIED (exit 0). Key id: ${kid}\n\nreceipt.json and events.jsonl must stay together: verify checks the signed event log beside the receipt.\n`);
    const again = await verifyReceipt(join(stage, "receipt.json"), { pubkey: pub });
    if (again.verdict !== "VERIFIED") throw new Error(`bundle does not verify on its own: ${again.verdict}${again.reasons.length ? `: ${again.reasons.join("; ")}` : ""}`);
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true }); // empty dir only, checked above
    mkdirSync(dirname(outDir), { recursive: true });
    renameSync(stage, outDir);
    return { ok: true, outDir, kid };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Audit export: every receipt for a commit range in one archive. Evidence export only; it certifies nothing. ----
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._\/~^@{}-]*$/;

export interface AuditRun { runId: string; runDir: string; commit: string; verdict: string }

/** verify.sh shipped in the archive. Takes head_sha, verdict and the verifying key id from the verifier's own `--json` output (never from a text scan of the receipt),
 *  binds every row to the audited commit range baked in below, and checks each pubkey.jwk kid against the key thumbprint the verifier computed.
 *  Needs an installed Loki CLI. Exit codes: 0 OK, 1 FAILED, 2 UNCHECKED (no verifier, or the verifier could not decide), 4 integrity OK but a run outcome not verified. */
export function auditVerifyScript(expected: number, rangeCommits: readonly string[], covered: number, receiptShas: readonly string[]): string {
  if (rangeCommits.some((c) => !/^[0-9a-f]{40,64}$/.test(c))) throw new Error("range commit list holds a non-hex entry");
  if (receiptShas.some((c) => !/^[0-9a-f]{64}$/.test(c))) throw new Error("receipt hash list holds a non-hex entry");
  return AUDIT_VERIFY_TEMPLATE.replace("__SHAS__", () => `\n${[...receiptShas].sort().join("\n")}\n`).replace("__NSHAS__", () => String(receiptShas.length)).replace("__EXPECTED__", () => String(expected)).replace("__COVERED__", () => String(covered)).replace("__RANGE__", () => `\n${rangeCommits.join("\n")}\n`);
}

const AUDIT_VERIFY_TEMPLATE = String.raw`#!/bin/sh
# Re-check of every receipt in this archive. Evidence check only; not a certification.
# Usage: sh verify.sh [--expect-kid KEY_ID]   (or LOKI_AUDIT_EXPECT_KID=KEY_ID)
# Verifier: LOKI_AUDIT_VERIFIER, else an installed "loki". Nothing is fetched; with no verifier the result is UNCHECKED.
# Exit: 0 OK, 1 FAILED (tamper or inconsistency), 2 UNCHECKED (no verifier, or it could not decide), 4 integrity OK but a run outcome is not verified.
# head_sha, verdict and the verifying key id are read from the verifier's --json output, never parsed out of the receipt text here.
if [ -n "$LOKI_AUDIT_VERIFIER" ]; then VERIFIER="$LOKI_AUDIT_VERIFIER"
elif command -v loki >/dev/null 2>&1; then VERIFIER="loki verify"
else VERIFIER=""; fi
vbin="$(printf '%s' "$VERIFIER" | cut -d' ' -f1)"
if [ -n "$VERIFIER" ] && ! command -v "$vbin" >/dev/null 2>&1; then echo "verifier: \"$VERIFIER\" (not found)"; VERIFIER=""
elif [ -n "$VERIFIER" ]; then echo "verifier: \"$VERIFIER\""
else echo "verifier: none found (install the Loki CLI with npm i -g loki-mode, or set LOKI_AUDIT_VERIFIER)"; fi
here="$(cd "$(dirname "$0")" && pwd)"
EXPECTED=__EXPECTED__
COVERED=__COVERED__
RANGE_COMMITS='__RANGE__'
RECEIPT_SHAS='__SHAS__'
NSHAS=__NSHAS__
EXPECT_KID="$LOKI_AUDIT_EXPECT_KID"
if [ "$1" = "--expect-kid" ]; then EXPECT_KID="$2"; fi
tmp="$(mktemp -d)" || { echo "FAIL cannot create a temp dir"; exit 1; }
trap 'rm -rf "$tmp"' EXIT
tamper=0; unchecked=0; outcome=0; n=0; kids=""; seen=""; shaseen=""; rowbad=0
bad() { echo "FAIL $1"; tamper=1; rowbad=1; }
jget() { printf '%s\n' "$jline" | sed -n 's/.*"'"$1"'":"\([^"\\]*\)".*/\1/p'; }
[ -f "$here/index.csv" ] || { echo "FAIL index.csv missing"; exit 1; }
nrows="$(tail -n +2 "$here/index.csv" | grep -c .)"
[ "$nrows" = "$EXPECTED" ] || bad "index.csv has $nrows row(s), archive was built with $EXPECTED"
[ -z "$(tail -n +2 "$here/index.csv" | cut -d, -f1 | sort | uniq -d)" ] || bad "index.csv repeats a run id"
for d in "$here"/receipts/* "$here"/receipts/.[!.]* "$here"/receipts/..?*; do
  [ -e "$d" ] || [ -L "$d" ] || continue
  tail -n +2 "$here/index.csv" | cut -d, -f1 | grep -Fxq "$(basename "$d")" || bad "$(basename "$d"): receipt directory has no index.csv row"
done
{ read -r _header; while IFS=, read -r run_id commit verdict _date; do
  [ -n "$run_id" ] || continue
  n=$((n + 1)); rowbad=0
  case "$run_id" in *[!A-Za-z0-9._-]*|.*) bad "$run_id: unsafe run id"; continue ;; esac
  d="$here/receipts/$run_id"
  if [ ! -f "$d/receipt.json" ]; then bad "$run_id: receipt missing"; continue; fi
  printf '%s\n' "$commit" | grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$' || bad "$run_id: index commit '$commit' is not a full commit hash"
  printf '%s\n' "$RANGE_COMMITS" | grep -Fxq "$commit" || bad "$run_id: commit '$commit' is not in the audited range"
  seen="$seen $commit"
  jkid="$(sed -n 's/.*"kid": *"\([^"]*\)".*/\1/p' "$d/pubkey.jwk" 2>/dev/null | head -n 1)"
  [ "$(grep -o '"kid"' "$d/pubkey.jwk" 2>/dev/null | wc -l | tr -d ' ')" = 1 ] || bad "$run_id: pubkey.jwk must carry exactly one kid field"
  if [ -z "$VERIFIER" ]; then echo "UNCHECKED $run_id: no verifier available"; unchecked=1; continue; fi
  (cd "$d" && $VERIFIER --json --pubkey pubkey.jwk receipt.json </dev/null >"$tmp/out" 2>"$tmp/err"); code=$?
  jline="$(grep '^{"run_id"' "$tmp/out" | tail -n 1)"
  vh="$(jget head_sha)"; vv="$(jget receipt_verdict)"; sk="$(jget signing_kid)"; kk="$(jget key_kid)"; ri="$(jget signed_run_id)"; rs="$(jget signed_sha256)"
  case "$code" in
    0|4)
      if [ -z "$jline" ]; then echo "UNCHECKED $run_id: verifier printed no --json identity (upgrade the Loki CLI)"; unchecked=1; continue; fi
      [ -n "$vh" ] || bad "$run_id: signed receipt has no head_sha"
      [ -n "$vh" ] && [ "$vh" = "$commit" ] || bad "$run_id: index commit '$commit' differs from signed head_sha '$vh'"
      [ -n "$vv" ] && printf '%s\n' "$vv" | grep -Eq '^[A-Za-z0-9_.-]+$' && [ "$vv" = "$verdict" ] || bad "$run_id: index verdict '$verdict' differs from signed verdict '$vv'"
      [ -n "$sk" ] && [ "$sk" = "$kk" ] || bad "$run_id: signing key id '$sk' is not the bundled key '$kk'"
      [ -n "$kk" ] && [ "$jkid" = "$kk" ] || bad "$run_id: pubkey.jwk kid '$jkid' is not the RFC 7638 thumbprint of its key '$kk'"
      [ -n "$ri" ] && [ "$ri" = "$run_id" ] || bad "$run_id: signed run_id '$ri' differs from the index run id"
      if [ -n "$rs" ] && printf '%s\n' "$RECEIPT_SHAS" | grep -Fxq "$rs"; then shaseen="$shaseen $rs"; else bad "$run_id: signed receipt hash '$rs' is not one of the receipts this archive was built with"; fi
      [ -z "$sk" ] || kids="$kids $sk"
      if [ -n "$EXPECT_KID" ] && [ "$sk" != "$EXPECT_KID" ]; then bad "$run_id: key id $sk is not the pinned key id"; fi
      if [ "$rowbad" = 0 ]; then
        if [ "$code" = 0 ]; then echo "OK   $run_id (kid $sk)"; else echo "OUTCOME $run_id: integrity OK, run outcome not verified"; outcome=1; fi
      fi ;;
    2|127)
      if [ -n "$jline" ] && [ "$code" = 2 ]; then bad "$run_id: the bundled pubkey.jwk does not verify this receipt (or it is unreadable or has no head_sha)"; tail -n 3 "$tmp/err" | sed "s/^/     /"
      else echo "UNCHECKED $run_id: verifier exit $code"; tail -n 3 "$tmp/err" | sed "s/^/     /"; unchecked=1; fi ;;
    *) echo "FAIL $run_id"; tail -n 3 "$tmp/err" | sed "s/^/     /"; tamper=1 ;;
  esac
done; } < "$here/index.csv"
[ "$n" = "$EXPECTED" ] || bad "checked $n receipt(s), archive was built with $EXPECTED"
ncommits="$(printf '%s\n' $seen | sort -u | grep -c .)"
[ "$ncommits" = "$COVERED" ] || bad "rows cover $ncommits distinct commit(s), archive was built covering $COVERED"
[ -z "$(printf '%s\n' $shaseen | sort | uniq -d)" ] || bad "two rows hold the same signed receipt"
nsha="$(printf '%s\n' $shaseen | sort -u | grep -c .)"
[ "$unchecked" = 1 ] || [ "$nsha" = "$NSHAS" ] || bad "rows hold $nsha distinct signed receipt(s), archive was built with $NSHAS"
ndistinct="$(printf '%s\n' $kids | sort -u | grep -c .)"
[ "$ndistinct" -le 1 ] || bad "archive mixes $ndistinct different signing keys: $(printf '%s\n' $kids | sort -u | tr '\n' ' ')"
if [ "$unchecked" = 1 ]; then echo "$n receipt(s) listed; not all could be checked"; else echo "$n receipt(s) checked; signing key id(s): $(printf '%s\n' $kids | sort -u | tr '\n' ' ')"; fi
if [ -n "$EXPECT_KID" ]; then echo "key id pinned to $EXPECT_KID"
else echo "NOTE: no pinned key id. This proves the archive is internally consistent only; pass --expect-kid <id> (or set LOKI_AUDIT_EXPECT_KID) with a key id you obtained from the signer out of band."; fi
if [ "$tamper" = 1 ]; then echo "RESULT: FAILED (tamper or inconsistency)"; exit 1; fi
if [ "$unchecked" = 1 ]; then echo "RESULT: UNCHECKED (no verifier, or the verifier could not decide)"; exit 2; fi
if [ "$outcome" = 1 ]; then echo "RESULT: integrity OK, at least one run outcome not verified"; exit 4; fi
echo "RESULT: OK"
exit 0
`;

function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Resolves <from>..<to> to the commit set. Refs are validated as data and passed as one argv entry, never through a shell. */
export function commitsInRange(repoDir: string, range: string): { ok: true; commits: Map<string, string> } | { ok: false; error: string } {
  const i = range.indexOf("..");
  const from = i > 0 ? range.slice(0, i) : "", to = i > 0 ? range.slice(i + 2) : "";
  if (!from || !to || !SAFE_REF.test(from) || !SAFE_REF.test(to) || from.includes("..") || to.includes("..")) return { ok: false, error: `invalid range '${range}'; expected <from>..<to> of plain refs` };
  const r = safeGitSpawn(repoDir, ["log", "--format=%H %cI", "--end-of-options", `${from}..${to}`], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, error: `git could not resolve ${range}: ${(r.stderr || "").trim().split("\n")[0] ?? ""}` };
  const commits = new Map<string, string>();
  for (const line of r.stdout.split("\n")) { const [h, d] = line.split(" "); if (h && d) commits.set(h, d); }
  return { ok: true, commits };
}

export interface UnreadableRun { runId: string; reason: string }

/** A run joins a range through receipt.head_sha, the field the Seal records for the run's final commit.
 *  A receipt that cannot be read or mapped to a commit (bad JSON, DSSE envelope, no head_sha, non-token verdict) is reported, never silently dropped. */
export function receiptsInRange(runsDir: string, commits: Map<string, string>): { runs: AuditRun[]; unreadable: UnreadableRun[] } {
  const runs: AuditRun[] = [], unreadable: UnreadableRun[] = [];
  if (!existsSync(runsDir)) return { runs, unreadable };
  for (const id of readdirSync(runsDir).sort()) {
    if (!SAFE_ID.test(id) || id.includes("..")) continue;
    const runDir = join(runsDir, id), rp = join(runDir, "receipt.json");
    if (!existsSync(rp)) continue;
    let r: unknown;
    try { r = JSON.parse(readFileSync(rp, "utf8")); } catch { unreadable.push({ runId: id, reason: "receipt.json is not valid JSON" }); continue; }
    if (!r || typeof r !== "object" || Array.isArray(r)) { unreadable.push({ runId: id, reason: "receipt.json is not a JSON object" }); continue; }
    if (isEnvelope(r)) { unreadable.push({ runId: id, reason: "receipt.json is a DSSE envelope; it cannot be mapped to a commit" }); continue; }
    const { head_sha, verdict } = r as { head_sha?: unknown; verdict?: unknown };
    if (typeof head_sha !== "string" || head_sha === "") { unreadable.push({ runId: id, reason: "receipt has no head_sha, so it cannot be mapped to a commit" }); continue; }
    if (!commits.has(head_sha)) continue;
    if (typeof verdict !== "string" || !/^[A-Za-z0-9_.-]+$/.test(verdict)) { unreadable.push({ runId: id, reason: "receipt verdict is missing or not a plain token" }); continue; }
    runs.push({ runId: id, runDir, commit: head_sha, verdict });
  }
  return { runs, unreadable };
}

/** Writes one .tgz: receipts/<run-id>/ (each a full single-run bundle), index.csv (run_id,commit,verdict,date), verify.sh (checks index.csv and the range against the verifier's own view of each signed receipt). */
export async function buildAuditBundle(runs: AuditRun[], commits: Map<string, string>, outFile: string): Promise<BundleResult> {
  if (runs.length === 0) return { ok: false, error: "no receipts found in that commit range" };
  if (existsSync(outFile)) return { ok: false, error: `${outFile} already exists; refusing to overwrite` };
  const stage = `${outFile}.tmp-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "receipts"), { recursive: true });
  try {
    let kid = ""; const shas: string[] = [];
    const rows = ["run_id,commit,verdict,date"];
    for (const r of runs) {
      if (!SAFE_ID.test(r.runId)) throw new Error(`unsafe run id ${r.runId}`);
      const b = await buildReceiptBundle(r.runDir, join(stage, "receipts", r.runId));
      if (!b.ok) throw new Error(`${r.runId}: ${b.error}`);
      kid = b.kid; shas.push(computeReceiptHash(JSON.parse(readFileSync(join(stage, "receipts", r.runId, "receipt.json"), "utf8"))));
      rows.push([r.runId, r.commit, r.verdict, commits.get(r.commit) ?? ""].map(csvCell).join(","));
    }
    writeFileSync(join(stage, "index.csv"), `${rows.join("\n")}\n`);
    writeFileSync(join(stage, "verify.sh"), auditVerifyScript(runs.length, [...commits.keys()], new Set(runs.map((r) => r.commit)).size, shas), { mode: 0o755 });
    const t = spawnSync("tar", ["-czf", outFile, "-C", stage, "."], { encoding: "utf8", env: tokenFreeEnv(process.env) });
    if (t.status !== 0) throw new Error(`tar failed: ${(t.stderr || "").trim()}`);
    rmSync(stage, { recursive: true, force: true });
    return { ok: true, outDir: outFile, kid };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
