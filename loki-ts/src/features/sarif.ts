// SARIF 2.1.0 converter: pure function from Loki findings to a SARIF log. No I/O, no network.
// Secret values are never emitted: secret findings carry only a label, and every free-text field is redacted.
import { createHash } from "node:crypto";
import { redactSecrets } from "../util/redact.ts";

export type FindingKind = "secret" | "not-proven" | "wall" | "verify";

export interface Finding {
  kind: FindingKind;
  message: string;
  file?: string;
  line?: number;
  // Stable identity text for the fingerprint (for example the matched rule or claim); defaults to the message.
  key?: string;
}

const RULES: Record<FindingKind, { id: string; name: string; level: "error" | "note"; text: string }> = {
  secret: { id: "loki/secret-scan", name: "SecretScan", level: "error", text: "A secret-like value was detected." },
  "not-proven": { id: "loki/not-proven", name: "NotProven", level: "note", text: "A claim was not proven by the run." },
  wall: { id: "loki/wall-failure", name: "WallFailure", level: "error", text: "A Wall check failed." },
  verify: { id: "loki/verify-failure", name: "VerifyFailure", level: "error", text: "A verification step failed." },
};

const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

// Repo-relative, forward-slash, percent-encoded URI; null when the path is outside the repo or unusable.
export function sarifUri(file: string, repoRoot?: string): string | null {
  let p = file.replace(/\\/g, "/");
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && p.startsWith(root + "/")) p = p.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    parts.push(seg);
  }
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || parts.length === 0 || parts.includes("..")) return null;
  return parts.map((seg) => encodeURIComponent(seg)).join("/");
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// Line numbers are excluded on purpose so the fingerprint survives line shifts.
export function findingFingerprint(f: Finding): string {
  const basis = f.kind === "secret" ? (f.key ?? "") : redactSecrets(f.key ?? f.message);
  return sha([RULES[f.kind].id, f.file ?? "", basis.trim().replace(/\s+/g, " ")].join("\0"));
}

export function toSarif(findings: Finding[], toolVersion = "0.0.0", repoRoot?: string): Record<string, unknown> {
  const used = [...new Set(findings.map((f) => f.kind))].map((k) => RULES[k]);
  const results = findings.map((f) => {
    const rule = RULES[f.kind];
    const text = f.kind === "secret" ? rule.text : redactSecrets(f.message);
    const result: Record<string, unknown> = {
      ruleId: rule.id,
      ruleIndex: used.indexOf(rule),
      level: rule.level,
      message: { text },
      partialFingerprints: { "lokiFinding/v1": findingFingerprint(f) },
    };
    const uri = f.file ? sarifUri(f.file, repoRoot) : null;
    if (uri) {
      const physicalLocation: Record<string, unknown> = { artifactLocation: { uri } };
      if (f.line && f.line > 0) physicalLocation.region = { startLine: f.line };
      result.locations = [{ physicalLocation }];
    }
    return result;
  });
  return {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Loki Mode",
            version: toolVersion,
            informationUri: "https://www.autonomi.dev/",
            rules: used.map((r) => ({ id: r.id, name: r.name, shortDescription: { text: r.text } })),
          },
        },
        results,
      },
    ],
  };
}
