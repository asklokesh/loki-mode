import { expect, test } from "bun:test";
import { redactEnvelope, redactEventData, redactSecrets } from "../../src/util/redact";

test("URL userinfo is replaced", () => {
  expect(redactSecrets("clone https://user:pass@example.com/repo now")).toBe("clone https://[REDACTED]@example.com/repo now");
  expect(redactSecrets("ssh://tok@host:22/x")).toBe("ssh://[REDACTED]@host:22/x");
});

test("plain URLs and mid-path @ are unchanged", () => {
  expect(redactSecrets("https://example.com/a@b?x=1")).toBe("https://example.com/a@b?x=1");
  expect(redactSecrets("mail me@host.com")).toBe("mail me@host.com");
});

test("Authorization header values are redacted", () => {
  expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [REDACTED]");
  expect(redactSecrets("authorization=abc123 next")).toBe("authorization=[REDACTED] next");
  expect(redactSecrets('-H "Authorization: Bearer abc"')).toBe('-H "Authorization: [REDACTED]"');
});

test("GitLab, npm, Hugging Face and Stripe tokens are redacted", () => {
  expect(redactSecrets("t=glpat-" + "a1".repeat(10))).toBe("t=[REDACTED:GITLAB_TOKEN]");
  expect(redactSecrets("npm_" + "A9".repeat(18))).toBe("[REDACTED:NPM_TOKEN]");
  expect(redactSecrets("hf_" + "aB".repeat(15))).toBe("[REDACTED:HF_TOKEN]");
  expect(redactSecrets("sk_live_" + "x".repeat(24))).toBe("[REDACTED:STRIPE_KEY]");
  expect(redactSecrets("rk_live_" + "x".repeat(24))).toBe("[REDACTED:STRIPE_KEY]");
});

test("token shape boundaries: too short or wrong prefix is unchanged", () => {
  for (const s of ["glpat-short", "npm_" + "a".repeat(35), "hf_" + "a".repeat(29), "sk_live_short", "sk_test_" + "x".repeat(24), "npm_install", "half_" + "a".repeat(40)]) {
    expect(redactSecrets(s)).toBe(s);
  }
});

test("PEM private key blocks are redacted, including multi-line and truncated", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKcwggSjAgEAAoIBAQC7\n";
  for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"]) {
    expect(redactSecrets(`a\n-----BEGIN ${kind}-----\n${body}-----END ${kind}-----\nb`)).toBe("a\n[REDACTED:PRIVATE_KEY]\nb");
  }
  expect(redactSecrets(`x -----BEGIN PRIVATE KEY-----\n${body}`)).toBe("x [REDACTED:PRIVATE_KEY]");
  expect(redactSecrets("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----")).toBe("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----");
});

test("vendor tokens", () => {
  const sg = "SG." + "a".repeat(22) + "." + "b".repeat(43);
  const tw = "SK" + "0123456789abcdef".repeat(2);
  const dk = "dckr_pat_" + "A1_-".repeat(6);
  const dop = "dop_v1_" + "ab12".repeat(16);
  const ya = "ya29." + "a0Af_-".repeat(5);
  expect(redactSecrets(`k=${sg} x`)).toBe("k=[REDACTED:SENDGRID_KEY] x");
  expect(redactSecrets(`k=${tw} x`)).toBe("k=[REDACTED:TWILIO_KEY] x");
  expect(redactSecrets(`k=${dk} x`)).toBe("k=[REDACTED:DOCKER_TOKEN] x");
  expect(redactSecrets(`k=${dop} x`)).toBe("k=[REDACTED:DIGITALOCEAN_TOKEN] x");
  expect(redactSecrets(`k=${ya} x`)).toBe("k=[REDACTED:GOOGLE_OAUTH_TOKEN] x");
  const ai = "AI" + "z".repeat(32);
  expect(redactSecrets(`k=SG.${"a".repeat(8)}${ai}.${"b".repeat(20)} x`)).toBe("k=[REDACTED:SENDGRID_KEY] x");
  expect(redactSecrets(`k=dckr_pat_${"a".repeat(8)}${ai} x`)).toBe("k=[REDACTED:DOCKER_TOKEN] x");
  expect(redactSecrets(`k=ya29.${"a".repeat(8)}${ai} x`)).toBe("k=[REDACTED:GOOGLE_OAUTH_TOKEN] x");
  const near = ["SG.short.tok", "SK" + "0".repeat(31), "SK" + "0".repeat(33), "xSK" + "0".repeat(32), "dckr_pat_abc", "dop_v1_" + "a".repeat(63), "dop_v1_" + "g".repeat(64), "ya29.short", "ya29"];
  for (const m of near) expect(redactSecrets(m)).toBe(m);
});

test("existing redactions unchanged", () => {
  expect(redactSecrets("sk-ant-" + "a".repeat(24))).toBe("[REDACTED:ANTHROPIC_KEY]");
  expect(redactSecrets("Bearer " + "a".repeat(24))).toBe("Bearer [REDACTED]");
});

test("secret query parameters are redacted, others kept", () => {
  expect(redactSecrets("https://h/x?access_token=abc123")).toBe("https://h/x?access_token=[REDACTED]");
  expect(redactSecrets("GET https://h/x?a=1&api_key=k1&apikey=k2&b=2 ok")).toBe("GET https://h/x?a=1&api_key=[REDACTED]&apikey=[REDACTED]&b=2 ok");
  expect(redactSecrets("https://h/x?TOKEN=t&password=p&secret=s&sig=z#frag")).toBe("https://h/x?TOKEN=[REDACTED]&password=[REDACTED]&secret=[REDACTED]&sig=[REDACTED]#frag");
  expect(redactSecrets('"https://h/x?sig=abc"')).toBe('"https://h/x?sig=[REDACTED]"');
});

test("non-secret query params and non-URL text are untouched", () => {
  expect(redactSecrets("https://h/x?page=2&sort=asc")).toBe("https://h/x?page=2&sort=asc");
  expect(redactSecrets("https://h/x?refresh_token_ttl=5&mytoken=1")).toBe("https://h/x?refresh_token_ttl=5&mytoken=1");
  expect(redactSecrets("a&token=x and password=y")).toBe("a&token=x and password=y");
});

// Q17-05b round 4: the engine hashes once-redacted bytes and the shipper and ingest redact again, so redaction must be a fixpoint.
const hex32 = "0123456789abcdef".repeat(2);
const SAMPLES = ["sk-ant-" + "a".repeat(24), "github_pat_" + "a".repeat(24), "ghp_" + "a".repeat(24), "xoxb-" + "a".repeat(12), "AKIA" + "A".repeat(16), "eyJa.b.c",
  "SG." + "a".repeat(16) + "." + "b".repeat(16), "SK" + hex32, "dckr_pat_" + "a".repeat(20), "dop_v1_" + "ab".repeat(32), "ya29." + "a".repeat(20), "AI" + "x".repeat(30),
  "glpat-" + "a".repeat(20), "npm_" + "A".repeat(36), "hf_" + "a".repeat(30), "sk_live_" + "a".repeat(16), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  "sk-" + "y".repeat(24), "Bearer " + "z".repeat(24), "https://u:p@h", "Authorization: Basic abc", "?token=abc", "[REDACTED:OPENAI_KEY]", "[REDACTED]"];
const idem = (s: string) => { const once = redactSecrets(s); return redactSecrets(once) === once; };

test("redaction is idempotent on the reviewer's adjacency cases (a \\b rule freed by a later rule's marker)", () => {
  const cases = ["SK" + hex32 + "AI" + "x".repeat(30), "dop_v1_" + "ab".repeat(32) + "sk-" + "y".repeat(24), "SK" + hex32 + "sk-" + "z".repeat(24)];
  expect(cases.map(redactSecrets)).toEqual(["[REDACTED:TWILIO_KEY][REDACTED:GOOGLE_KEY]", "[REDACTED:DIGITALOCEAN_TOKEN][REDACTED:OPENAI_KEY]", "[REDACTED:TWILIO_KEY][REDACTED:OPENAI_KEY]"]);
  for (const c of cases) expect(idem(c)).toBe(true);
  const data = { task: cases[0], not_proven: [cases[1]], [cases[2]!]: 1 };
  const once = redactEventData("run.started", data);
  expect(redactEventData("run.started", once)).toEqual(once);
  const env = { v: 1, seq: 0, run: cases[2], type: "run.started", data };
  expect(redactEnvelope(redactEnvelope(env))).toEqual(redactEnvelope(env));
});

test("redaction is idempotent over every ordered pair and triple of rule samples, joined by every separator", () => {
  const seps = ["", " ", "=", ":", "-", "_", ".", "/", "@", "&"];
  const bad: string[] = [];
  for (const a of SAMPLES) for (const b of SAMPLES) for (const sep of seps) {
    if (!idem(a + sep + b)) bad.push(a + sep + b);
    for (const c of ["SK" + hex32, "dop_v1_" + "ab".repeat(32), "AI" + "x".repeat(30)]) if (!idem(c + a + sep + b) || !idem(a + sep + b + c)) bad.push(c + "|" + a + sep + b);
  }
  expect(bad).toEqual([]);
});
