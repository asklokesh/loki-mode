import { expect, test } from "bun:test";
import { redactSecrets } from "../../src/util/redact";

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
