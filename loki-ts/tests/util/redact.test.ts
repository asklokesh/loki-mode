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

test("existing redactions unchanged", () => {
  expect(redactSecrets("sk-ant-" + "a".repeat(24))).toBe("[REDACTED:ANTHROPIC_KEY]");
  expect(redactSecrets("Bearer " + "a".repeat(24))).toBe("Bearer [REDACTED]");
});
