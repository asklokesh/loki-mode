// TEN-ADOPTION-02: package a sealed run as a self-contained directory a third party can verify offline.
import { createPublicKey, type KeyObject } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { verifyReceipt } from "../engine10/verify_cmd.ts";
import { kidOf, loadSigningKey } from "./receipt_signer.ts";

export type BundleResult = { ok: true; outDir: string; kid: string } | { ok: false; error: string };

export const VERIFY_COMMAND = "npx loki-mode verify --pubkey pubkey.jwk receipt.json";

type Preflight = { ok: true; receiptPath: string; eventsPath: string; pub: KeyObject; kid: string } | { ok: false; error: string };

/** The refusals shared by every export: a receipt must exist, a signing key must be on this machine, and the receipt must verify locally against it. */
async function preflight(runDir: string): Promise<Preflight> {
  const receiptPath = join(runDir, "receipt.json"), eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(receiptPath)) return { ok: false, error: `no receipt.json in ${runDir}` };
  const priv = loadSigningKey(false);
  if (!priv) return { ok: false, error: "no receipt signing key on this machine; cannot publish a verifying public key" };
  const pub = createPublicKey(priv), kid = kidOf(pub);
  const v = await verifyReceipt(receiptPath, { pubkey: pub });
  if (v.verdict !== "VERIFIED") return { ok: false, error: `receipt is ${v.verdict}${v.reasons.length ? `: ${v.reasons.join("; ")}` : ""}; only a locally VERIFIED signed receipt can be bundled` };
  if (!existsSync(eventsPath)) return { ok: false, error: `events.jsonl missing in ${runDir}` };
  return { ok: true, receiptPath, eventsPath, pub, kid };
}

/** Writes receipt.json, events.jsonl, pubkey.jwk (public half only) and VERIFY.md into outDir.
 *  Refuses, writing nothing, unless the run's receipt is signed and verifies locally against the signer's public key. */
export async function buildReceiptBundle(runDir: string, outDir: string): Promise<BundleResult> {
  const pre = await preflight(runDir);
  if (!pre.ok) return pre;
  const { receiptPath, eventsPath, pub, kid } = pre;
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
    writeFileSync(join(stage, "VERIFY.md"), `# Verify this Loki receipt\n\nRun from this directory. No Loki install or account is needed.\n\n\`\`\`\n${VERIFY_COMMAND}\n\`\`\`\n\nExpected: VERIFIED (exit 0). Key id: ${kid}\n\nreceipt.json and events.jsonl must stay together: verify checks the signed event log beside the receipt.\n`);
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

// R100-016: one self-contained page that re-checks a receipt in a browser with no install and no network.
export const HTML_MAX_BYTES = 1_000_000;
export type HtmlResult = { ok: true; html: string; kid: string } | { ok: false; error: string };

/** Mirrors verifyReceipt (engine10/verify_cmd.ts) for a plain loki.v10.receipt/1 with a jwt and a signed log: hash, schema, event log, attestation, kid, log.sealed.
 *  Shapes the page cannot check alone (DSSE, composite, group, evidence screens) end UNCHECKED, never VERIFIED. Runs in a browser and in Node (parity test): `subtle` is WebCrypto. */
export const PAGE_VERIFIER_JS = String.raw`async function lokiVerifyBundle(b, subtle) {
  var enc = new TextEncoder(), dec = new TextDecoder();
  var hex = function (buf) { return Array.from(new Uint8Array(buf), function (x) { return x.toString(16).padStart(2, "0"); }).join(""); };
  var sha = async function (s) { return hex(await subtle.digest("SHA-256", enc.encode(s))); };
  var unb64u = function (s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
  var b64u = function (buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  var canon = function (x) {
    var walk = function (v) {
      if (Array.isArray(v)) return "[" + v.map(walk).join(",") + "]";
      if (v !== null && typeof v === "object") return "{" + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ":" + walk(v[k]); }).join(",") + "}";
      return JSON.stringify(v === undefined ? null : v);
    };
    return walk(x).replace(/[\u0080-￿]/g, function (c) { return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"); });
  };
  var isPlain = function (v) { return v !== null && typeof v === "object" && !Array.isArray(v); };
  var R = function (verdict, reasons) { return { verdict: verdict, reasons: reasons }; };
  var receipt;
  try { receipt = JSON.parse(b.receipt); } catch (e) { return R("UNCHECKED", ["receipt.json is not valid JSON"]); }
  if (!isPlain(receipt)) return R("UNCHECKED", ["receipt.json is not a JSON object"]);
  var jwk = b.pubkey, kid;
  try { kid = b64u(await subtle.digest("SHA-256", enc.encode('{"crv":"Ed25519","kty":"OKP","x":"' + jwk.x + '"}'))); } catch (e) { return R("UNCHECKED", ["the embedded public key is unusable"]); }
  if (typeof receipt.payloadType === "string" && typeof receipt.payload === "string" && Array.isArray(receipt.signatures)) return R("UNCHECKED", ["this is a DSSE envelope; the page cannot check it, run: npx loki-mode verify --pubkey pubkey.jwk receipt.json"]);
  if (receipt.schema === "loki.v10.composite/1") return R("UNCHECKED", ["this is a composite receipt; the page cannot check it, run: npx loki-mode verify --pubkey pubkey.jwk receipt.json"]);
  var unsupported = [];
  var computed = await sha(canon((function () { var o = {}; Object.keys(receipt).forEach(function (k) { if (k !== "verification" && k !== "receipt_sha256") o[k] = receipt[k]; }); return o; })()));
  if (typeof receipt.receipt_sha256 !== "string" || receipt.receipt_sha256 !== computed) return R("TAMPERED", ["receipt_sha256 mismatch: recorded " + JSON.stringify(receipt.receipt_sha256 === undefined ? null : receipt.receipt_sha256) + ", computed " + computed]);
  if (receipt.schema !== "loki.v10.receipt/1" && receipt.schema !== "loki.v10.group/1") return R("TAMPERED", ["unrecognized receipt schema " + JSON.stringify(receipt.schema === undefined ? null : receipt.schema) + "; a renamed or removed schema would downgrade the receipt past its checks"]);
  if (receipt.schema === "loki.v10.group/1" && !isPlain(receipt.group)) return R("TAMPERED", ["a loki.v10.group/1 receipt has no group section; it was edited or renamed from another schema"]);
  var isoTs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  var envOk = function (x) {
    if (!isPlain(x)) return false;
    var keys = ["v", "seq", "ts", "run", "type", "stage", "data"];
    for (var i = 0; i < keys.length; i++) if (!(keys[i] in x)) return false;
    if (x.v !== 1 || !Number.isInteger(x.seq) || x.seq < 0 || typeof x.ts !== "string" || !isoTs.test(x.ts)) return false;
    if (typeof x.run !== "string" || x.run === "" || typeof x.type !== "string" || x.type === "") return false;
    if (x.stage !== null && (typeof x.stage !== "string" || x.stage === "")) return false;
    if (!isPlain(x.data)) return false;
    var ids = ["group_id", "unit_id"];
    for (var j = 0; j < ids.length; j++) if (ids[j] in x.data && (typeof x.data[ids[j]] !== "string" || x.data[ids[j]] === "")) return false;
    if ("deps" in x.data && (!Array.isArray(x.data.deps) || x.data.deps.some(function (d) { return typeof d !== "string"; }))) return false;
    return true;
  };
  var lines = (b.events || "").split("\n").filter(function (l) { return l.trim() !== ""; });
  var events = [];
  lines.forEach(function (l) { try { var x = JSON.parse(l); if (envOk(x)) events.push(x); } catch (e) { /* torn or corrupt line */ } });
  var bound = receipt.events_sha256;
  if (receipt.schema === "loki.v10.receipt/1") {
    var time = receipt.time, hashOk = typeof bound === "string" && /^[0-9a-f]{64}$/.test(bound);
    var miss = !hashOk ? "events_sha256" : !time || typeof time !== "object" ? "time" : !isPlain(time.stages) ? "time.stages" : null;
    if (miss) return R("TAMPERED", ["the receipt is missing a valid " + miss + ", which seal always writes; it was edited."]);
  }
  if (typeof bound === "string") {
    var emptyHash = await sha("");
    if (bound === emptyHash) {
      var st = receipt.time && receipt.time.stages, claims = st !== null && typeof st === "object" && Object.keys(st).length > 0;
      if (claims) return R("TAMPERED", ["the receipt records stages but binds the empty-log hash, so no events.jsonl can back it; the receipt is forged or was sealed without a log."]);
    } else {
      if (!b.events) return R("TAMPERED", ["events.jsonl is missing"]);
      if (events.length !== lines.length || events.some(function (e, i) { return e.seq !== i; })) return R("TAMPERED", ["events.jsonl has a forged, edited or missing line"]);
      if (events.some(function (e) { return e.type === "tamper.detected"; })) return R("TAMPERED", ["the supervisor detected events.jsonl being modified during the run"]);
      var matched = false, acc = "";
      for (var i = 0; i <= lines.length && !matched; i++) { if (await sha(acc) === bound) matched = true; else if (i < lines.length) acc += lines[i] + "\n"; }
      if (!matched) return R("TAMPERED", ["events.jsonl does not match the hash recorded at seal"]);
    }
  }
  if (receipt.schema === "loki.v10.group/1") unsupported.push("group unit receipts are not in this page");
  if (receipt.evidence_screens !== undefined) unsupported.push("evidence screenshots are not in this page");
  var ver = receipt.verification || {}, jwt = ver.jwt === undefined ? null : ver.jwt;
  if (jwt !== null && typeof jwt !== "string") return R("UNCHECKED", ["verification.jwt is not a string"]);
  if (!jwt) return unsupported.length ? R("UNCHECKED", unsupported) : R("UNSIGNED", []);
  var parts = jwt.split(".");
  var bad = function (r) { return R("TAMPERED", [r]); };
  if (!parts[0] || !parts[1] || !parts[2] || parts.length > 3) return bad("malformed token");
  var header, payload;
  try { header = JSON.parse(dec.decode(unb64u(parts[0]))); payload = JSON.parse(dec.decode(unb64u(parts[1]))); } catch (e) { return bad("malformed token"); }
  if (!header || header.alg !== "EdDSA") return bad("unexpected alg: " + String(header && header.alg));
  if (header.kid !== kid) return R("UNCHECKED", ["no key for kid " + String(header.kid) + " in this page (the embedded key is " + kid + ")"]);
  var key;
  try { key = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]); } catch (e) { return R("UNCHECKED", ["this browser cannot verify Ed25519 signatures (WebCrypto Ed25519 is missing)"]); }
  var sigOk;
  try { sigOk = await subtle.verify({ name: "Ed25519" }, key, unb64u(parts[2]), enc.encode(parts[0] + "." + parts[1])); } catch (e) { sigOk = false; }
  if (!sigOk) return bad("signature does not verify");
  if (!payload || payload.receipt_sha256 !== computed) return bad("attestation binds a different receipt hash");
  if (ver.kid !== undefined && ver.kid !== header.kid) return bad("verification.kid differs from the signing kid in the attestation header (metadata outside the signed digest was edited)");
  if (receipt.log_seal === true) {
    var done = events.findIndex(function (e) { return e.type === "run.completed"; });
    if (!events.some(function (e) { return e.type === "receipt.sealed" && e.data.receipt_sha256 === computed; })) return bad("events.jsonl has no receipt.sealed event for this receipt");
    if (done < 0) return R("UNCHECKED", ["run did not complete, or the log was truncated (no run.completed in events.jsonl)"]);
    var seal = events[done + 1], d = seal && seal.type === "log.sealed" ? seal.data : null;
    if (!d) return bad("events.jsonl has no signed log.sealed line after run.completed");
    var logSha = await sha(lines.slice(0, done + 1).join("\n") + "\n"), lsOk = false;
    if (d.kid === header.kid && d.events_sha256 === logSha && d.tampered === false && typeof d.sig === "string") {
      try { lsOk = await subtle.verify({ name: "Ed25519" }, key, unb64u(d.sig), enc.encode(logSha + ":false")); } catch (e) { lsOk = false; }
    }
    if (!lsOk) return bad("log.sealed line is invalid, forged or signed by another key");
  }
  return unsupported.length ? R("UNCHECKED", unsupported) : R("VERIFIED", []);
}`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'";

/** Builds the single-file page: receipt, event log and public key inline, CSP connect-src 'none'. Same refusals as the bundle (signed, locally VERIFIED). */
export async function buildReceiptHtml(runDir: string): Promise<HtmlResult> {
  const pre = await preflight(runDir);
  if (!pre.ok) return pre;
  const { x, kty, crv } = pre.pub.export({ format: "jwk" });
  const data = { receipt: readFileSync(pre.receiptPath, "utf8"), events: readFileSync(pre.eventsPath, "utf8"), pubkey: { kty, crv, x, kid: pre.kid } };
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loki receipt check</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:42rem;padding:1.5rem 16px;color:#1a1a1a;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}h1{font-size:1.25rem}#verdict{font-size:2rem;font-weight:700;margin:1rem 0}.VERIFIED{color:#0a7d33}.TAMPERED,.UNCHECKED,.UNSIGNED{color:#b3261e}code{word-break:break-all}li{margin:.25rem 0}</style>
</head><body>
<h1>Loki receipt check</h1>
<p>This page re-checks one sealed receipt in your browser. It holds the receipt, its event log and the signer's public key, and makes no network request.</p>
<div id="verdict" role="status">Checking...</div>
<ul id="reasons"></ul>
<p>Run: <code id="run">${esc(String((JSON.parse(data.receipt) as { run_id?: unknown }).run_id ?? ""))}</code></p>
<p>Receipt hash: <code id="hash"></code></p>
<p>Signer key id: <code id="kid">${esc(pre.kid)}</code></p>
<p>The key is embedded in this page, so a match proves the receipt was not edited after signing. It does not prove who signed: compare the key id above with one you trust.</p>
<script type="application/json" id="bundle">${jsonForScript(data)}</script>
<script>
${PAGE_VERIFIER_JS}
(async function () {
  var out = document.getElementById("verdict"), why = document.getElementById("reasons");
  var violations = 0;
  document.addEventListener("securitypolicyviolation", function () { violations++; document.documentElement.setAttribute("data-csp-violations", String(violations)); });
  var r;
  try { r = await lokiVerifyBundle(JSON.parse(document.getElementById("bundle").textContent), crypto.subtle); } catch (e) { r = { verdict: "UNCHECKED", reasons: ["the page could not run: " + String(e && e.message || e)] }; }
  out.textContent = r.verdict; out.className = r.verdict;
  document.documentElement.setAttribute("data-verdict", r.verdict);
  r.reasons.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; why.appendChild(li); });
  try { document.getElementById("hash").textContent = JSON.parse(JSON.parse(document.getElementById("bundle").textContent).receipt).receipt_sha256 || ""; } catch (e) { /* shown blank */ }
})();
</script>
</body></html>
`;
  if (Buffer.byteLength(html) > HTML_MAX_BYTES) return { ok: false, error: `page would be ${Buffer.byteLength(html)} bytes, over the ${HTML_MAX_BYTES} byte limit; use 'loki proof bundle' for a receipt this large` };
  return { ok: true, html, kid: pre.kid };
}
