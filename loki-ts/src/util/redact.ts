// Token redaction for one-line terminal output. Patterns ported from autonomy/lib/proof_redact.py
// (order matters: specific before generic). ponytail: tokens and Bearer only; full proof redaction stays in Python.
/** TEN-SECURITY-25: key=value, key: value and JSON "key": "value" for names ending in password, passwd, secret, token or api_key. The name must END with the
 *  keyword as its own segment so max_tokens, token_count and tokens: stay readable. A match starts only where no name char precedes it (linear on long a_a_a runs, never mid-word
 *  as in mytoken=1) and consumes leading and repeated separators, so --password=, --db-password=, _token= and __SECRET= still redact. Values already redacted ([REDACTED...]) are skipped, which keeps the rule idempotent. */
const ASSIGNMENT = /((?<![A-Za-z0-9_.-])[_.-]*(?:[A-Za-z0-9]+[_.-]+)*(?:password|passwd|secret|token|api[_-]?key|apikey)["']?\s*[:=]\s*)((?:"(?!\[REDACTED)(?:\\.|[^"\\\n])+")|(?:'(?!\[REDACTED)(?:\\.|[^'\\\n])+')|(?!["']|\[REDACTED)[^\s"',;&]+)/gi;
/** A name that ends in the keyword with no separator (MYTOKEN=, xtoken=, 9token=) redacts only when the value looks like a credential (16+ of [A-Za-z0-9_-]), so mytoken=1 stays readable.
 *  Same name-start guard as ASSIGNMENT keeps it linear; the value is never an already-redacted marker, which keeps the rule idempotent. */
const GLUED_ASSIGNMENT = /((?<![A-Za-z0-9_.-])[_.-]*(?:[A-Za-z0-9]+[_.-]+)*[A-Za-z0-9]*(?:password|passwd|secret|token|api[_-]?key|apikey)["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{16,}[^\s"',;&]*/gi;
const RULES: [RegExp, string | ((...a: string[]) => string)][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED:ANTHROPIC_KEY]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:GITHUB_TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:GITHUB_TOKEN]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:SLACK_TOKEN]"],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[REDACTED:AWS_KEY]"],
  [/(AccountKey=)[A-Za-z0-9+/]{40,}={0,2}/g, "$1[REDACTED:AZURE_KEY]"],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED:JWT]"],
  [/SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[REDACTED:SENDGRID_KEY]"],
  [/(?<![A-Za-z0-9])SK[0-9a-f]{32}\b/g, "[REDACTED:TWILIO_KEY]"],
  [/pypi-AgEI[A-Za-z0-9_-]{50,}/g, "[REDACTED:PYPI_TOKEN]"],
  [/\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}\b/g, "[REDACTED:SHOPIFY_TOKEN]"],
  [/\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g, "[REDACTED:POSTMAN_KEY]"],
  [/dapi[a-f0-9]{32}(?:-\d)?\b/g, "[REDACTED:DATABRICKS_TOKEN]"],
  [/(?<![A-Za-z0-9])key-[a-f0-9]{32}\b/g, "[REDACTED:MAILGUN_KEY]"],
  [/dckr_pat_[A-Za-z0-9_-]{20,}/g, "[REDACTED:DOCKER_TOKEN]"],
  [/dop_v1_[a-f0-9]{64}\b/g, "[REDACTED:DIGITALOCEAN_TOKEN]"],
  [/ya29\.[A-Za-z0-9_-]{20,}/g, "[REDACTED:GOOGLE_OAUTH_TOKEN]"],
  [/AIza[A-Za-z0-9_-]{35}/g, "[REDACTED:GOOGLE_KEY]"],
  [/glpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED:GITLAB_TOKEN]"],
  [/npm_[A-Za-z0-9]{36}/g, "[REDACTED:NPM_TOKEN]"],
  [/hf_[A-Za-z0-9]{30,}/g, "[REDACTED:HF_TOKEN]"],
  [/(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED:STRIPE_KEY]"],
  [/whsec_[A-Za-z0-9]{16,}/g, "[REDACTED:STRIPE_WEBHOOK_SECRET]"],
  [/\bhooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]{16,}/g, "hooks.slack.com/services/[REDACTED:SLACK_WEBHOOK]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED:PRIVATE_KEY]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:OPENAI_KEY]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, "$1[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]{0,63}:\/\/)[^\s/?#@]+@/gi, "$1[REDACTED]@"], // TEN-SECURITY-26: a bounded scheme keeps this linear; unbounded, every word start in a long a--a run rescanned it (quadratic)
  [ASSIGNMENT, (_m: string, pre: string, val: string) => (val[0] === '"' || val[0] === "'" ? `${pre}${val[0]}[REDACTED]${val[0]}` : `${pre}[REDACTED]`)],
  [GLUED_ASSIGNMENT, "$1[REDACTED]"],
  [/(\bAuthorization\s*[:=]\s*)(?:Basic|Bearer|Token|Digest)?\s*[^\s,;"']+/gi, "$1[REDACTED]"],
];
const QUERY_SEGMENT = /\?[^\s#"'<>]+/g;
const SECRET_PARAM = /([?&](?:access_token|token|api_key|apikey|password|secret|sig)=)[^&\s#"']*/gi;
const redactQuery = (s: string): string =>
  s.replace(QUERY_SEGMENT, (q) => q.replace(SECRET_PARAM, "$1[REDACTED]"));
const redactOnce = (s: string): string => redactQuery(RULES.reduce((a, [re, to]) => (typeof to === "string" ? a.replace(re, to) : a.replace(re, to)), s));
/** Q17-05b: one pass is not idempotent. A \b rule (TWILIO, DIGITALOCEAN) runs before a later rule (GOOGLE_KEY, OPENAI) whose marker creates a new word
 *  boundary next to the earlier token, so a second pass redacts more. Layers that hash (engine) and re-redact (shipper, ingest) must agree on bytes, so
 *  iterate to a fixpoint. Every pass that changes the text removes a secret, so the bound is never reached by real data. */
const MAX_PASSES = 32;
export const redactSecrets = (s: string): string => {
  let cur = s;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = redactOnce(cur);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
};
/** Redacts every string value and object key (arrays and objects recursed); non-strings pass through. Idempotent (redactSecrets is a fixpoint), so redacting at source and again at ship or ingest is a no-op. */
export const redactDeep = (x: unknown): unknown =>
  typeof x === "string" ? redactSecrets(x)
  : Array.isArray(x) ? x.map(redactDeep)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [redactSecrets(k), redactDeep(v)]))
  : x;
/** Q17-05b: engine-computed crypto fields of the integrity lines. A base64url sig or kid matches a token rule by chance (about 1.7% of log.sealed sigs match
 *  an OPENAI sk- token rule), and a redacted one forges TAMPERED. Only a value of the exact shape the engine writes is exempt; every other field is redacted. */
const B64 = (n: number): RegExp => new RegExp(`^[A-Za-z0-9_-]{${n}}$`), HEX64 = /^[0-9a-f]{64}$/;
const SEAL_FIELDS = new Map<string, Map<string, RegExp>>([
  ["log.sealed", new Map([["kid", B64(43)], ["sig", B64(86)], ["events_sha256", HEX64]])],
  ["receipt.sealed", new Map([["kid", B64(43)], ["receipt_sha256", HEX64], ["events_sha256", HEX64]])],
]);
/** The one event-data redaction every layer uses (engine writer, shipper, ingest), so all three produce the same bytes. */
export const redactEventData = (type: string, data: unknown): unknown => {
  const keep = SEAL_FIELDS.get(type);
  if (!keep || !data || typeof data !== "object" || Array.isArray(data)) return redactDeep(data);
  return Object.fromEntries(Object.entries(data).map(([k, v]) => (typeof v === "string" && keep.get(k)?.test(v) ? [k, v] : [redactSecrets(k), redactDeep(v)])));
};
/** A whole event envelope: data through redactEventData keyed on the envelope type, every other field through redactDeep. Key order is kept. */
export const redactEnvelope = <T extends { type: string; data: unknown }>(e: T): T =>
  Object.fromEntries(Object.entries(e).map(([k, v]) => [redactSecrets(k), k === "data" ? redactEventData(e.type, v) : redactDeep(v)])) as T;
/** E-120: implement's spec_conflict_reason is model-written and lands verbatim in the receipt,
 *  a trust artifact; a reason containing "\n\n## Loki receipt: VERIFIED" would otherwise forge a
 *  second heading. Collapse all control chars (including newlines) to a single space, cap the
 *  length, and strip backticks so the caller can safely wrap it in a single inline-code span. */
export function sanitizeReason(s: string): string {
  const collapsed = s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const capped = collapsed.length > 500 ? `${collapsed.slice(0, 500)}...` : collapsed;
  return capped.replace(/`/g, "'");
}
/** Attacker-controlled text printed on a terminal or in a report: every character in this class (C0 and C1 controls incl. ESC and CSI U+009B, DEL, soft hyphen, Arabic letter mark, zero-width and bidi format characters, word joiner and invisible operators, U+2028/2029, BOM) must become "?". The ONE copy; callers import it rather than keep a narrower one. */
export const UNSAFE_TERMINAL_CHARS_RE = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
