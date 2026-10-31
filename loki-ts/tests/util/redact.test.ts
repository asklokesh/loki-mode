import { describe, expect, test } from "bun:test";
import { redactEnvelope, redactEventData, redactSecrets } from "../../src/util/redact";

test("URL userinfo is replaced", () => {
  expect(redactSecrets("clone https://user:pass@example.com/repo now")).toBe("clone https://[REDACTED]@example.com/repo now");
  expect(redactSecrets("ssh://tok@host:22/x")).toBe("ssh://[REDACTED]@host:22/x");
  expect(redactSecrets("pip install git+https://user:tok@host/x")).toBe("pip install git+https://[REDACTED]@host/x");
  expect(redactSecrets("x-very.long-scheme+v2://u:p@host")).toBe("x-very.long-scheme+v2://[REDACTED]@host");
});

test("URL userinfo rule is linear on long scheme-char runs (TEN-SECURITY-26)", () => {
  // Unbounded, every word start in a--a--a rescanned the run looking for :// (57ms, 254ms, 779ms at 1x, 2x, 4x).
  // Doubling the input must not much more than double the time; an absolute floor keeps tiny timings stable.
  const time = (s: string): number => { const t0 = performance.now(); redactSecrets(s); return performance.now() - t0; };
  for (const unit of ["--a", "a.", "a-b+"]) {
    const small = time(unit.repeat(5000)), big = time(unit.repeat(20000));
    expect(big).toBeLessThan(Math.max(50, small * 8)); // 4x the input; quadratic would be about 16x
  }
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
  for (const s of ["glpat-short", "npm_" + "a".repeat(35), "hf_" + "a".repeat(29), "sk_live_short", "sk_prod_" + "x".repeat(24), "npm_install", "half_" + "a".repeat(40)]) {
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

test("SendGrid rule leaves identifiers ending in SG alone and still redacts real keys", () => {
  const tail = "." + "a".repeat(22) + "." + "b".repeat(43);
  for (const id of ["MSG.applicationSettingsKey", "I18N_MSG.someKey", "xSG" + tail, "_SG" + tail, "9SG" + tail]) expect(redactSecrets(id)).toBe(id);
  const key = "SG" + tail;
  expect(redactSecrets(`key=${key}`)).toBe("key=[REDACTED:SENDGRID_KEY]");
  expect(redactSecrets(`"${key}"`)).toBe('"[REDACTED:SENDGRID_KEY]"');
  expect(redactSecrets(`token ${key}`)).toBe("token [REDACTED:SENDGRID_KEY]");
  expect(redactSecrets(key)).toBe("[REDACTED:SENDGRID_KEY]");
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
  expect(redactSecrets("a&page=x and note=y")).toBe("a&page=x and note=y");
});

// Q17-05b round 4: the engine hashes once-redacted bytes and the shipper and ingest redact again, so redaction must be a fixpoint.
const hex32 = "0123456789abcdef".repeat(2);
const SAMPLES = ["sk-ant-" + "a".repeat(24), "github_pat_" + "a".repeat(24), "ghp_" + "a".repeat(24), "xoxb-" + "a".repeat(12), "AKIA" + "A".repeat(16), "eyJa.b.c",
  "SG." + "a".repeat(16) + "." + "b".repeat(16), "SK" + hex32, "dckr_pat_" + "a".repeat(20), "dop_v1_" + "ab".repeat(32), "ya29." + "a".repeat(20), "AIza" + "x".repeat(35),
  "glpat-" + "a".repeat(20), "npm_" + "A".repeat(36), "hf_" + "a".repeat(30), "sk_live_" + "a".repeat(16), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  "sk-" + "y".repeat(24), "Bearer " + "z".repeat(24), "https://u:p@h", "Authorization: Basic abc", "?token=abc", "[REDACTED:OPENAI_KEY]", "[REDACTED]"];
const idem = (s: string) => { const once = redactSecrets(s); return redactSecrets(once) === once; };

test("redaction is idempotent on the reviewer's adjacency cases (a \\b rule freed by a later rule's marker)", () => {
  const cases = ["SK" + hex32 + "AIza" + "x".repeat(35), "dop_v1_" + "ab".repeat(32) + "sk-" + "y".repeat(24), "SK" + hex32 + "sk-" + "z".repeat(24)];
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
    for (const c of ["SK" + hex32, "dop_v1_" + "ab".repeat(32), "AIza" + "x".repeat(35)]) if (!idem(c + a + sep + b) || !idem(a + sep + b + c)) bad.push(c + "|" + a + sep + b);
  }
  expect(bad).toEqual([]);
});

test("vendor tokens: PyPI, Shopify, Postman, Databricks, Mailgun are redacted", () => {
  const hex = (n: number) => "0123456789abcdef".repeat(4).slice(0, n);
  const cases: [string, string][] = [
    ["pypi-AgEIcHlwaS5vcmc" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6", "PYPI_TOKEN"],
    ["shpat_" + hex(32), "SHOPIFY_TOKEN"],
    ["PMAK-" + hex(24) + "-" + hex(34), "POSTMAN_KEY"],
    ["dapi" + hex(32), "DATABRICKS_TOKEN"],
    ["key-" + hex(32), "MAILGUN_KEY"],
  ];
  for (const [tok, label] of cases) {
    const out = redactSecrets(`value ${tok} end`);
    expect(out).toBe(`value [REDACTED:${label}] end`);
    expect(redactSecrets(out)).toBe(out);
  }
  for (const benign of ["key-value", "dapi-docs", "pypi-package", "shpat_short", "monkey-" + hex(32), "PMAK-notatoken"]) {
    expect(redactSecrets(benign)).toBe(benign);
  }
});

test("asia and azure: AWS temporary ASIA keys and Azure AccountKey values are redacted", () => {
  const asia = "ASIA" + "ABCDEFGHIJKLMNOP";
  const azKey = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6+/ab==";
  expect(redactSecrets(`id ${asia} end`)).toBe("id [REDACTED:AWS_KEY] end");
  const conn = `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${azKey};EndpointSuffix=core.windows.net`;
  const out = redactSecrets(conn);
  expect(out).toBe("DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=[REDACTED:AZURE_KEY];EndpointSuffix=core.windows.net");
  expect(redactSecrets(out)).toBe(out);
  for (const benign of ["ASIA-pacific", "ASIAshort", "AccountKey=short", "AccountName=acct"]) expect(redactSecrets(benign)).toBe(benign);
});

test("google key shape", () => {
  const key = "AIza" + "C".repeat(35);
  expect(redactSecrets(`key=${key} end`)).toBe("key=[REDACTED:GOOGLE_KEY] end");
  const ident = "AIProviderRegistryConfigurationManager42";
  expect(redactSecrets(ident)).toBe(ident);
  const long = "AI" + "b".repeat(40);
  expect(redactSecrets(`x ${long} y`)).toBe(`x ${long} y`);
});

test("slack stripe redact", () => {
  const w = "hooks.slack.com/services/T01ABCDEF/B02GHIJKL/" + "a1B2c3D4e5F6g7H8i9J0k1L2";
  expect(redactSecrets(`curl -X POST https://${w} -d x`)).toBe("curl -X POST https://hooks.slack.com/services/[REDACTED:SLACK_WEBHOOK] -d x");
  expect(redactSecrets(w)).toBe("hooks.slack.com/services/[REDACTED:SLACK_WEBHOOK]");
  const k = "A1b2C3d4E5f6G7h8I9j0K1l2";
  expect(redactSecrets(`sk_test_${k} rk_test_${k} rk_live_${k}`)).toBe("[REDACTED:STRIPE_KEY] [REDACTED:STRIPE_KEY] [REDACTED:STRIPE_KEY]");
  expect(redactSecrets(`whsec_${k}`)).toBe("[REDACTED:STRIPE_WEBHOOK_SECRET]");
  expect(redactSecrets(`key%3Dsk_live_${k}`)).toBe("key%3D[REDACTED:STRIPE_KEY]");
  expect(redactSecrets(`STRIPE_sk_live_${k} x9sk_live_${k}`)).toBe("STRIPE_[REDACTED:STRIPE_KEY] x9[REDACTED:STRIPE_KEY]");
  for (const benign of ["sk_test_short", "whsec_short", "hooks.slack.com/services/help", "task_sk_test_" + k.toLowerCase().slice(0, 3), "https://hooks.slack.com/docs", "hooks.slack.com/services/T0/B0/short"]) expect(redactSecrets(benign)).toBe(benign);
  for (const s of [w, `sk_test_${k}`, `whsec_${k}`, `x ${w}${w}`]) expect(redactSecrets(redactSecrets(s))).toBe(redactSecrets(s));
  expect(redactEventData("run.started", { u: w, k: `whsec_${k}` })).toEqual({ u: "hooks.slack.com/services/[REDACTED:SLACK_WEBHOOK]", k: "[REDACTED:STRIPE_WEBHOOK_SECRET]" });
});

test("assignment redact", () => {
  expect(redactSecrets("password=hunter2 user=bob")).toBe("password=[REDACTED] user=bob");
  expect(redactSecrets("DB_PASSWORD: hunter2")).toBe("DB_PASSWORD: [REDACTED]");
  expect(redactSecrets('{"api_key": "abc123", "n": 1}')).toBe('{"api_key": "[REDACTED]", "n": 1}');
  expect(redactSecrets("client_secret='s3cr3t value'")).toBe("client_secret='[REDACTED]'");
  expect(redactSecrets("export GITHUB_TOKEN=abc123 && run")).toBe("export GITHUB_TOKEN=[REDACTED] && run");
  expect(redactSecrets("passwd=x1;apikey=y2")).toBe("passwd=[REDACTED];apikey=[REDACTED]");
  expect(redactSecrets("token=ghp_" + "a".repeat(30))).toBe("token=[REDACTED:GITHUB_TOKEN]");
  for (const benign of ["max_tokens=4096", "tokens: 5", "token_count: 12", "password reset sent", "secrets are fine", "password=", "key=value"]) expect(redactSecrets(benign)).toBe(benign);
  for (const s of ["password=hunter2", '"secret": "x y"', "a token: tk9 b"]) expect(redactSecrets(redactSecrets(s))).toBe(redactSecrets(s));
  expect(redactEventData("run.started", { cmd: "curl -d password=hunter2" })).toEqual({ cmd: "curl -d password=[REDACTED]" });
});

test("assignment redact is linear and handles escaped quotes", () => {
  expect(redactSecrets('{"password":"x\\"y z","n":1}')).toBe('{"password":"[REDACTED]","n":1}');
  for (const big of ["a_".repeat(10000), "a_".repeat(10000) + "token"]) {
    const t0 = performance.now();
    redactSecrets(big);
    expect(performance.now() - t0).toBeLessThan(100);
  }
});

test("assignment redact covers flag and separator-prefixed names", () => {
  const pw = "hun" + "ter2";
  expect(redactSecrets("--password=" + pw)).toBe("--password=[REDACTED]");
  expect(redactSecrets("--db-password=" + pw)).toBe("--db-password=[REDACTED]");
  expect(redactSecrets("-p --api-key=" + "abc123")).toBe("-p --api-key=[REDACTED]");
  expect(redactSecrets("_token=" + "abc")).toBe("_token=[REDACTED]");
  expect(redactSecrets("__SECRET=" + "s3")).toBe("__SECRET=[REDACTED]");
  expect(redactSecrets("export .token=" + "abc")).toBe("export .token=[REDACTED]");
  expect(redactSecrets("cmd --db__password=" + pw + " -x")).toBe("cmd --db__password=[REDACTED] -x");
  for (const benign of ["mytoken=1", "https://h/x?refresh_token_ttl=5&mytoken=1", "x_mytoken=1", "--max-tokens=5", "--tokens=3"]) expect(redactSecrets(benign)).toBe(benign);
  for (const big of ["-".repeat(20000), "_a".repeat(10000), "a__".repeat(7000) + "=", "--a".repeat(7000) + "token"]) {
    const t0 = performance.now();
    redactSecrets(big);
    expect(performance.now() - t0).toBeLessThan(100);
  }
});

describe("redaction survives glue (a secret directly after a word char)", () => {
  const h32 = "0123456789abcdef".repeat(2);
  // strict: the shape keeps a letter/digit guard because a pinned control (xSK..., monkey-<hex>) says an alphanumeric neighbour is benign.
  const shapes: [string, string, string, boolean][] = [
    ["DOCKER_TOKEN", "dckr_pat_" + "A1_-".repeat(6), "dckr", false],
    ["GOOGLE_OAUTH_TOKEN", "ya29." + "a0Af_-".repeat(5), "ya29", false],
    ["SENDGRID_KEY", "SG." + "a".repeat(22) + "." + "b".repeat(43), "SG", false],
    ["DIGITALOCEAN_TOKEN", "dop_v1_" + "ab12".repeat(16), "dop", false],
    ["DATABRICKS_TOKEN", "dapi" + h32, "dapi", false],
    ["PYPI_TOKEN", "pypi-AgEIcHlwaS5vcmc" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6", "pypi", false],
    ["TWILIO_KEY", "SK" + h32, "SK", true],
    ["MAILGUN_KEY", "key-" + h32, "key", true],
  ];
  for (const [label, tok, name, strict] of shapes) {
    for (const [lead, tag] of [["", "line start"], ["x", "after x"], ["9", "after 9"], ["_", "after _"], ["-", "after -"], [".", "after ."]] as const) {
      const alnum = lead === "x" || lead === "9";
      test(`${name} ${tag}`, () => {
        const input = lead + tok;
        if (strict && alnum) expect(redactSecrets(input)).toBe(input);
        else {
          const out = redactSecrets(input);
          expect(out).toBe(`${lead}[REDACTED:${label}]`);
          expect(redactSecrets(out)).toBe(out);
        }
      });
    }
  }

  const cred = "A1b2C3d4E5f6G7h8";
  const glued = ["MYTOKEN", "mytoken", "xtoken", "9token", "MYSECRET", "mysecret", "MYPASSWORD", "mypassword", "MYPASSWD", "xpasswd", "MYAPIKEY", "myapikey", "MYAPI_KEY", "myapi_key"];
  for (const k of glued) {
    test(`glued key ${k} redacts a credential-shaped value`, () => {
      expect(redactSecrets(`${k}=${cred}`)).toBe(`${k}=[REDACTED]`);
      expect(redactSecrets(`export ${k}: ${cred} && run`)).toBe(`export ${k}: [REDACTED] && run`);
      expect(redactSecrets(`{"${k}": "${cred}"}`)).toBe(`{"${k}": "[REDACTED]"}`);
      const once = redactSecrets(`${k}=${cred}`);
      expect(redactSecrets(once)).toBe(once);
    });
  }
  test("readable cases stay readable", () => {
    for (const s of ["token_count=3", "max_tokens=1", "mytoken=1", "xtoken=" + cred.slice(0, 15), "9token=abc", "mytoken=hello world foo", "tokens=" + cred, "mytokens=" + cred, "mytoken_count=" + cred, "mytoken " + cred, "mytoken=[REDACTED]"]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });
  test("a non-secret neighbour of a distinctive prefix stays unredacted", () => {
    for (const s of ["monkey-" + h32, "xSK" + h32, "9key-" + h32, "dckr_pat_abc", "ya29.short", "SG.short.tok", "dapi-docs", "pypi-package", "dop_v1_" + "a".repeat(63)]) expect(redactSecrets(s)).toBe(s);
  });
  test("linear on 100k-char adversarial input (under 50ms each)", () => {
    const inputs = ["a".repeat(100000), "a".repeat(100000) + "token", "x".repeat(100000) + "token=" + "y".repeat(100000), "a_".repeat(50000) + "token", "-".repeat(100000),
      "token".repeat(20000), "token=".repeat(16667), "SG.".repeat(33333), "ya29.".repeat(20000), "key-".repeat(25000), "dapi".repeat(25000), "dckr_pat_".repeat(11111), "SK".repeat(50000), "pypi-AgEI".repeat(11111)];
    for (const big of inputs) {
      const t0 = performance.now();
      redactSecrets(big);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});
