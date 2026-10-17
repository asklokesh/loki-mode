// Token redaction for one-line terminal output. Patterns ported from autonomy/lib/proof_redact.py
// (order matters: specific before generic). ponytail: tokens and Bearer only; full proof redaction stays in Python.
const RULES: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED:ANTHROPIC_KEY]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:GITHUB_TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:GITHUB_TOKEN]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:SLACK_TOKEN]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:AWS_KEY]"],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED:JWT]"],
  [/AI[a-zA-Z0-9_-]{30,}/g, "[REDACTED:GOOGLE_KEY]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:OPENAI_KEY]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, "$1[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1[REDACTED]@"],
  [/(\bAuthorization\s*[:=]\s*)(?:Basic|Bearer|Token|Digest)?\s*[^\s,;"']+/gi, "$1[REDACTED]"],
];
export const redactSecrets = (s: string): string => RULES.reduce((a, [re, to]) => a.replace(re, to), s);
/** Redacts every string value (arrays and objects recursed); keys and non-strings pass through. Idempotent, so redacting at source and again at ship or ingest is a no-op. */
export const redactDeep = (x: unknown): unknown =>
  typeof x === "string" ? redactSecrets(x)
  : Array.isArray(x) ? x.map(redactDeep)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, redactDeep(v)]))
  : x;
