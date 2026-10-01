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
];
export const redactSecrets = (s: string): string => RULES.reduce((a, [re, to]) => a.replace(re, to), s);
