// Tests for src/runner/retry_class.ts (v8 harness intelligence 3d: smart retry).
//
// The load-bearing property is the FAIL-SAFE DIRECTION, stated in the module
// header and in CLAUDE.md: an unrecognized failure stays TRANSIENT and retries
// as before; only a positively-identified permanent failure stops early; rate
// limits are explicitly excluded from the permanent set.
//
// The scan target is what makes this sharp. classifyFailure is handed the
// agent's ENTIRE captured output (autonomous.ts:856-860, the same
// capturedOutputPath that checkCompletionPromise reads at autonomous.ts:835),
// not a provider error envelope. So a build that merely IMPLEMENTS auth or
// payments prints auth/payment vocabulary in its own test logs and UI copy. A
// classifier that matched that vocabulary would call a healthy build
// non-retryable and terminate the whole run (autonomous.ts:873-881 returns
// exit 1; it does not just skip one retry). These tests pin BOTH directions:
// benign application text must stay transient, AND real provider failures must
// still be caught -- without that second half, deleting the pattern list
// entirely would pass.
//
// Pure functions over strings, so no fixtures and no tmpdir are needed.

import { describe, expect, it } from "bun:test";
import { classifyFailure, shouldStopRetrying } from "../../src/runner/retry_class.ts";

describe("classifyFailure: benign agent output stays transient", () => {
  // Each of these is text a HEALTHY build emits while working on the feature
  // named. None is a provider rejecting the request. All must retry.
  const benign: ReadonlyArray<readonly [string, string]> = [
    [
      "auth test log asserting a 401",
      "Running tests...\n  auth.test.ts: expect(res.status).toBe(401)\n  FAIL 1 test\nexit 1",
    ],
    [
      "prose describing a permission-denied path",
      "I added a permission denied path to the API. Build failed: tsc error TS2345.",
    ],
    [
      "a 403 in an integration fixture",
      "GET /admin -> 403 (expected)\nBuild error: cannot find module 'foo'",
    ],
    [
      "payment UI copy",
      "Implemented the payment required upsell banner. Compile failed.",
    ],
    [
      "an unauthorized string in a route handler",
      "res.status(401).json({ error: 'Unauthorized' })\nSyntaxError: unexpected token",
    ],
    [
      "a 400 validation branch",
      "return 400 invalid payload\nesbuild: build failed with 1 error",
    ],
  ];

  for (const [name, text] of benign) {
    it(`retries: ${name}`, () => {
      const d = classifyFailure(text);
      expect(d.klass).toBe("transient");
      expect(shouldStopRetrying(d)).toBe(false);
    });
  }
});

describe("classifyFailure: the safe default holds for unrecognized input", () => {
  // This is the property that actually protects users. Anything the classifier
  // does not positively recognize must behave exactly as it did before smart
  // retry existed: keep retrying.
  const unrecognized: ReadonlyArray<readonly [string, string]> = [
    ["a segfault", "Segmentation fault (core dumped)"],
    ["an unknown compiler error", "error: linker command failed with exit code 1"],
    ["opaque provider noise", "unexpected end of JSON input"],
    ["empty output", ""],
    ["whitespace only", "   \n\t  "],
  ];

  for (const [name, text] of unrecognized) {
    it(`retries: ${name}`, () => {
      const d = classifyFailure(text);
      expect(d.klass).toBe("transient");
      expect(shouldStopRetrying(d)).toBe(false);
    });
  }

  it("labels a truly unrecognized failure as such", () => {
    expect(classifyFailure("Segmentation fault (core dumped)").reason).toBe("unrecognized");
  });
});

describe("classifyFailure: real permanent provider failures still stop early", () => {
  // Without these, deleting the whole pattern list would pass the suite above.
  const permanent: ReadonlyArray<readonly [string, string, string]> = [
    ["bad api key", "Error: invalid x-api-key", "auth"],
    ["invalid api key wording", "invalid_api_key: the supplied credential is not valid", "auth"],
    ["authentication failed", "authentication_error: authentication failed", "auth"],
    ["unknown model", "model_not_found: the model does not exist", "unknown_model"],
    ["malformed request", "invalid_request_error: messages must be non-empty", "bad_request"],
    ["exhausted credit", "Your credit balance is too low to access the API", "quota_exhausted"],
    ["insufficient quota", "insufficient_quota: please add funds", "quota_exhausted"],
  ];

  for (const [name, text, reason] of permanent) {
    it(`stops early: ${name}`, () => {
      const d = classifyFailure(text);
      expect(d.klass).toBe("non_retryable");
      expect(d.reason).toBe(reason);
      expect(shouldStopRetrying(d)).toBe(true);
    });
  }
});

describe("rate limits are never permanent", () => {
  // Explicitly excluded from the permanent set: a rate limit clears with time,
  // and treating it as permanent would abandon healthy builds.
  const rateLimited = [
    "429 rate limit exceeded",
    "rate_limit_error: please try again later",
    "overloaded_error: server is overloaded",
    "503 service unavailable",
    "ETIMEDOUT",
  ];

  for (const text of rateLimited) {
    it(`retries: ${text.slice(0, 32)}`, () => {
      const d = classifyFailure(text);
      expect(d.klass).toBe("transient");
      expect(shouldStopRetrying(d)).toBe(false);
    });
  }

  it("a rate limit wins over quota-adjacent wording in the same text", () => {
    // A 429 body often carries quota language. The transient override must win.
    const d = classifyFailure("429 rate limit exceeded: insufficient quota for this minute");
    expect(d.klass).toBe("transient");
    expect(d.reason).toBe("transient_marker");
  });
});

describe("shouldStopRetrying: LOKI_SMART_RETRY=0 restores retry-everything", () => {
  it("never stops when disabled, even for a positively-identified failure", () => {
    const d = classifyFailure("Error: invalid x-api-key");
    expect(d.klass).toBe("non_retryable");
    expect(shouldStopRetrying(d, { LOKI_SMART_RETRY: "0" })).toBe(false);
  });

  it("is on by default when the knob is unset", () => {
    const d = classifyFailure("Error: invalid x-api-key");
    expect(shouldStopRetrying(d, {})).toBe(true);
  });
});
