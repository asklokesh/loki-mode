"""tests/test_proof_redaction.py -- THE GATE for proof-of-run redaction (R1).

This is the security chokepoint test. It has three layers:

  1. A corpus that covers every secret pattern in the R1 spec REDACTION RULES.
     redact_tree() must leave ZERO leak for each.
  2. An end-to-end test: build a tiny .loki fixture seeded with secrets in the
     brief, council summaries, and (with --include-diffs) a real git diff, run
     the standalone generator, and assert NO secret substring and NO
     /Users/<user> // /home/<user> survives in BOTH proof.json AND index.html.
  3. Invariants: redaction.applied is always True, and the generator REFUSES to
     emit if the redaction chokepoint is bypassed (monkeypatched).

Notes that match the implementation (verified against autonomy/lib/proof_redact.py
and autonomy/lib/proof-generator.py), NOT bugs:
  - A bare 40-char AWS secret is only redacted in assignment form
    (aws_secret_access_key=...). A standalone 40-char token is intentionally
    left alone, so the corpus uses the assignment form.
  - Path redaction strips the /Users|/home prefix and the USERNAME segment, but
    the trailing path tail survives by design (/Users/alice/x.py -> ~/x.py or
    .../x.py). Assertions check the username/prefix are gone, not the whole path.
  - .env / AWS-assign redaction KEEPS the key and drops the value.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LIB = os.path.join(_REPO, "autonomy", "lib")
_GENERATOR = os.path.join(_LIB, "proof-generator.py")

# proof_redact.py has an importable name (underscore); add lib to path.
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import proof_redact  # noqa: E402


# Secrets that must NEVER survive redaction anywhere. Each is a (label, secret)
# pair; the secret value is the substring that must be gone from output. These
# are synthetic, structurally-valid-looking tokens, not real credentials.
_ANTHROPIC = "sk-ant-api03-" + "A" * 40
_OPENAI = "sk-" + "B" * 40
_GOOGLE = "AIza" + "C" * 35
_GHP = "ghp_" + "d" * 36
_GHO = "gho_" + "e" * 36
_AKIA = "AKIA" + "ABCDEFGHIJ234567"  # AKIA + 16 upper/digits
_AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1"  # 40 chars
_SLACK = "xoxb-" + "1234567890-" + "fGhIjKlMnOpQ"
_BEARER_TOK = "abcDEF1234567890ghIJKL=="
_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJzdWIiOiIxMjM0NTY3ODkwIn0"
    ".dQw4w9WgXcQabcdefghijklmnop"
)
_PEM_BODY = "MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA" + "x" * 30
_PEM = (
    "-----BEGIN RSA PRIVATE KEY-----\n"
    + _PEM_BODY
    + "\n-----END RSA PRIVATE KEY-----"
)


class RedactionCorpusTests(unittest.TestCase):
    """Every spec pattern, asserted to leave zero leak via redact_tree()."""

    def setUp(self):
        proof_redact.reset_context()

    def tearDown(self):
        proof_redact.reset_context()

    def _assert_redacted(self, label, raw_value, must_be_gone):
        """redact_tree on a nested structure must remove must_be_gone."""
        tree = {
            "top": raw_value,
            "nested": {"k": [raw_value, {"deep": raw_value}]},
            label: raw_value,  # also redact in a KEY
        }
        out, count = proof_redact.redact_tree(tree)
        blob = json.dumps(out)
        self.assertNotIn(
            must_be_gone, blob,
            "%s leaked: %r still present in %r" % (label, must_be_gone, blob),
        )
        self.assertGreater(count, 0, "%s: expected redactions_count > 0" % label)

    def test_anthropic_key(self):
        self._assert_redacted("anthropic", _ANTHROPIC, _ANTHROPIC)

    def test_openai_key(self):
        self._assert_redacted("openai", _OPENAI, _OPENAI)

    def test_google_key(self):
        self._assert_redacted("google", _GOOGLE, _GOOGLE)

    def test_github_token_ghp(self):
        self._assert_redacted("ghp", _GHP, _GHP)

    def test_github_token_gho(self):
        self._assert_redacted("gho", _GHO, _GHO)

    def test_aws_access_key_id(self):
        self._assert_redacted("akia", _AKIA, _AKIA)

    def test_aws_secret_assignment(self):
        # AWS secret only redacted in assignment form (by design).
        line = "AWS_SECRET_ACCESS_KEY=" + _AWS_SECRET
        out, count = proof_redact.redact_tree({"v": line})
        blob = json.dumps(out)
        self.assertNotIn(_AWS_SECRET, blob, "AWS secret value leaked: %r" % blob)
        # Key name is preserved.
        self.assertIn("AWS_SECRET_ACCESS_KEY", blob)
        self.assertGreater(count, 0)

    def test_slack_token(self):
        self._assert_redacted("slack", _SLACK, _SLACK)

    def test_bearer_token(self):
        line = "Authorization: Bearer " + _BEARER_TOK
        out, count = proof_redact.redact_tree({"v": line})
        blob = json.dumps(out)
        self.assertNotIn(_BEARER_TOK, blob, "Bearer token leaked: %r" % blob)
        # Scheme is preserved.
        self.assertIn("Bearer", blob)
        self.assertGreater(count, 0)

    def test_jwt(self):
        self._assert_redacted("jwt", _JWT, _JWT)

    def test_pem_private_key_block_dropped_whole(self):
        out, count = proof_redact.redact_tree({"key": _PEM})
        blob = json.dumps(out)
        self.assertNotIn(_PEM_BODY, blob, "PEM body leaked: %r" % blob)
        self.assertNotIn("PRIVATE KEY-----", blob)
        self.assertGreater(count, 0)

    def test_env_assignments_keep_key_drop_value(self):
        cases = [
            ("DB_PASSWORD", "DB_PASSWORD=hunter2supersecret"),
            ("MY_API_KEY", "MY_API_KEY: zzzsecretvaluezzz"),
            ("SESSION_TOKEN", "SESSION_TOKEN=tok_aaaaaaaaaaaa"),
            ("APP_SECRET", "APP_SECRET=shhh-do-not-tell"),
            ("DB_PASS", "DB_PASS=p@ssw0rdshould_vanish"),
            ("MY_CREDENTIAL", "MY_CREDENTIAL=cred-xyz-123456"),
        ]
        for key, line in cases:
            out, count = proof_redact.redact_tree({"v": line})
            blob = json.dumps(out)
            value = line.split("=" if "=" in line else ":", 1)[1].strip()
            self.assertNotIn(
                value, blob, "%s value leaked: %r" % (key, blob))
            self.assertIn(key, blob, "%s key should be preserved" % key)
            self.assertGreater(count, 0, "%s: expected a redaction" % key)

    def test_quoted_json_secret_assignments_redact_value(self):
        # JSON object form: the closing quote of the key sits between the key
        # and the colon, which the bare-form regex never matched (the council
        # bypass). The value must be redacted while the key and quotes survive.
        cases = [
            ('db_password', '"db_password": "hunter2"', "hunter2"),
            ('token', '"token":"abc123xyz"', "abc123xyz"),
            ('client_secret', '"client_secret": "cs-shh-9090"', "cs-shh-9090"),
            ('access_token', '"access_token": "at_aaaaaa"', "at_aaaaaa"),
            ('refresh_token', '"refresh_token": "rt_bbbbbb"', "rt_bbbbbb"),
            ('api_key', '"api_key": "k-zzzzzz"', "k-zzzzzz"),
            ('auth', '"auth": "Basic dXNlcjpwYXNz"', "Basic dXNlcjpwYXNz"),
            # single-quoted YAML-ish form.
            ('passwd', "'passwd': 'shplain99'", "shplain99"),
        ]
        for label, line, value in cases:
            out, count = proof_redact.redact_tree({"v": line})
            blob = json.dumps(out)
            self.assertNotIn(
                value, blob, "%s value leaked: %r" % (label, blob))
            self.assertIn("[REDACTED]", blob,
                          "%s: expected a redaction marker in %r" % (label, blob))
            self.assertGreater(count, 0, "%s: expected a redaction" % label)

    def test_aws_secret_quoted_json_form_redacted(self):
        # The typed AWS-secret regex anchors on [=:], so the JSON form
        # ("aws_secret_access_key": "...") slipped past it (the council bypass).
        # The generic assignment rule must now catch the quoted value.
        line = '"aws_secret_access_key": "%s"' % _AWS_SECRET
        out, count = proof_redact.redact_tree({"v": line})
        blob = json.dumps(out)
        self.assertNotIn(_AWS_SECRET, blob, "AWS secret leaked: %r" % blob)
        self.assertIn("aws_secret_access_key", blob)
        self.assertIn("[REDACTED]", blob)
        self.assertGreater(count, 0)

    def test_uri_connection_string_credentials_redacted(self):
        # scheme://user:PASSWORD@host -> the password component must be scrubbed
        # for any scheme. No rule existed before (the council bypass). The
        # scheme/user/host are kept so the artifact stays diagnostic.
        cases = [
            ("postgres", "postgres://user:p4ssw0rd@host:5432/db", "p4ssw0rd"),
            ("mongodb", "mongodb://admin:Sup3rSecret@10.0.0.5:27017",
             "Sup3rSecret"),
            ("redis", "redis://:s3cretpw@host:6379", "s3cretpw"),
            ("amqp", "amqp://user:rabbitpass@host", "rabbitpass"),
            ("https", "https://user:tok_secret@host", "tok_secret"),
        ]
        for scheme, uri, password in cases:
            out, count = proof_redact.redact_tree({"v": uri})
            blob = json.dumps(out)
            self.assertNotIn(
                password, blob, "%s password leaked: %r" % (scheme, blob))
            self.assertIn("[REDACTED]", blob,
                          "%s: redaction marker missing in %r" % (scheme, blob))
            # Scheme/host kept for diagnostics.
            self.assertIn(scheme + "://", blob)
            self.assertGreater(count, 0, "%s: expected a redaction" % scheme)

    def test_uri_without_credentials_is_untouched(self):
        # A plain URL with no user:pass@ credential must NOT be altered.
        for uri in ("https://example.com/path", "http://localhost:8080",
                    "postgres://host:5432/db"):
            out, count = proof_redact.redact_tree({"v": uri})
            self.assertEqual(out["v"], uri, "URL altered unexpectedly: %r" % uri)
            self.assertEqual(count, 0)

    def test_passphrase_keyword_redacted(self):
        # Council round-2 finding: "passphrase" (SSH/GPG/wallet/keystore secret)
        # was missing from the keyword alternation and leaked unchanged.
        cases = [
            "passphrase=mysecretkey",
            '"passphrase": "mysecretkey"',
            "PASS_PHRASE=abc123secret",
            "GPG_PASSPHRASE: topsecretvalue",
        ]
        for raw in cases:
            out, count = proof_redact.redact_tree({"v": raw})
            blob = json.dumps(out)
            self.assertNotIn("mysecretkey", blob, "passphrase leaked: %r" % blob)
            self.assertNotIn("abc123secret", blob, "passphrase leaked: %r" % blob)
            self.assertNotIn("topsecretvalue", blob,
                             "passphrase leaked: %r" % blob)
            self.assertIn("[REDACTED]", blob)

    def test_uri_password_with_slash_redacted(self):
        # Council round-2 finding: the URI password class stopped at the first
        # "/", so a password containing "/" leaked. It must stop only at "@".
        cases = [
            ("postgres://user:p/ss@host:5432/db", "p/ss"),
            ("mongodb://admin:s/e/cret@10.0.0.5:27017", "s/e/cret"),
        ]
        for uri, password in cases:
            out, count = proof_redact.redact_tree({"v": uri})
            blob = json.dumps(out)
            self.assertNotIn(password, blob,
                             "slash-password leaked: %r" % blob)
            self.assertIn("[REDACTED]", blob)
            self.assertGreater(count, 0)

    def test_assignment_redaction_is_linear_on_long_input(self):
        # ReDoS guard: the assignment/URI patterns must stay linear so a large
        # diff cannot hang the proof generator. Assert a wall-clock budget.
        import time
        for s in ("a" * 200000,
                  "password=" + "x" * 200000,
                  "postgres://" + "u" * 100000 + ":" + "p" * 100000 + "@h",
                  "postgres://" + "u" * 200000):
            start = time.monotonic()
            proof_redact.redact_value(s)
            elapsed = time.monotonic() - start
            self.assertLess(
                elapsed, 1.0,
                "redaction took %.3fs on a long input (possible ReDoS)"
                % elapsed)

    def test_unix_home_paths_strip_username(self):
        cases = [
            ("/Users/alice/secret/app.py", "alice"),
            ("/home/bobsmith/project/main.go", "bobsmith"),
        ]
        for path, username in cases:
            out, count = proof_redact.redact_tree({"p": path})
            blob = json.dumps(out)
            self.assertNotIn(username, blob, "username leaked: %r" % blob)
            self.assertNotIn("/Users/", blob)
            self.assertNotIn("/home/", blob)
            self.assertGreater(count, 0)

    def test_windows_home_path_strip_username(self):
        path = "C:\\Users\\charlie\\app\\config.json"
        out, count = proof_redact.redact_tree({"p": path})
        blob = json.dumps(out)
        self.assertNotIn("charlie", blob, "windows username leaked: %r" % blob)
        self.assertNotIn("C:\\\\Users", blob)
        self.assertGreater(count, 0)

    def test_multiple_secrets_in_one_string_all_redacted(self):
        s = "key1=%s and token=%s and path=%s" % (_OPENAI, _GHP,
                                                   "/Users/dave/x")
        out, count = proof_redact.redact_tree({"v": s})
        blob = json.dumps(out)
        self.assertNotIn(_OPENAI, blob)
        self.assertNotIn(_GHP, blob)
        self.assertNotIn("dave", blob)
        # Multiple individual redactions counted.
        self.assertGreaterEqual(count, 3)

    def test_non_string_values_untouched(self):
        tree = {"n": 42, "f": 1.5, "b": True, "z": None, "list": [1, 2, 3]}
        out, count = proof_redact.redact_tree(tree)
        self.assertEqual(out, tree)
        self.assertEqual(count, 0)


class RedactionEndToEndTests(unittest.TestCase):
    """Run the real generator on a secret-seeded .loki fixture; assert no leak
    survives in either proof.json or index.html."""

    def setUp(self):
        # tmp OUTSIDE the repo so git -C does not pick up the real repo diff.
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-redact-e2e-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_loki(self, loki_dir, brief_secret, summary_secret):
        os.makedirs(os.path.join(loki_dir, "metrics", "efficiency"))
        os.makedirs(os.path.join(loki_dir, "council", "votes"))
        # Efficiency record.
        with open(os.path.join(loki_dir, "metrics", "efficiency",
                               "iteration-1.json"), "w") as f:
            json.dump({"cost_usd": 0.8731, "input_tokens": 1234,
                       "output_tokens": 567, "model": "claude-sonnet"}, f)
        # Generated PRD brief seeded with multiple secrets + an abs path.
        brief = (
            "Build a thing. Connect with %s and deploy from "
            "/Users/secretuser/repo. Also DB_PASSWORD=%s.\n"
            % (brief_secret, "topsecretdbpass")
        )
        with open(os.path.join(loki_dir, "generated-prd.md"), "w") as f:
            f.write(brief)
        # Council state + one reviewer vote with a secret in the summary.
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({"enabled": True, "threshold": 3,
                       "verdicts": [{"verdict": "APPROVE"}]}, f)
        with open(os.path.join(loki_dir, "council", "votes",
                               "reviewer-1.json"), "w") as f:
            json.dump({"role": "principal", "vote": "APPROVE",
                       "summary": "Looks good. Saw token %s in logs."
                       % summary_secret}, f)

    def _run_generator(self, loki_dir, out_dir, include_diffs=False):
        cmd = [sys.executable, _GENERATOR,
               "--loki-dir", loki_dir, "--out-dir", out_dir,
               "--run-id", "e2e-fixed-001", "--quiet"]
        if include_diffs:
            cmd.append("--include-diffs")
        env = dict(os.environ)
        # Force a deterministic, secret-bearing HOME so path redaction has a
        # concrete prefix to collapse; the generic /Users//home/ rules also fire.
        env["HOME"] = "/Users/secretuser"
        env.pop("PRD_PATH", None)
        env.pop("_LOKI_ITER_START_SHA", None)
        r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                           timeout=60)
        self.assertEqual(r.returncode, 0, "generator failed: %s" % r.stderr)

    def _assert_no_leak(self, out_dir, leaks):
        proof_path = os.path.join(out_dir, "proof.json")
        html_path = os.path.join(out_dir, "index.html")
        proof_text = open(proof_path, "r").read()
        html_text = open(html_path, "r").read()
        for label, secret in leaks:
            self.assertNotIn(
                secret, proof_text,
                "%s leaked into proof.json" % label)
            self.assertNotIn(
                secret, html_text,
                "%s leaked into index.html" % label)
        # No absolute user-home prefix in either artifact.
        for art_name, art in (("proof.json", proof_text),
                              ("index.html", html_text)):
            self.assertNotIn("/Users/secretuser", art,
                             "abs HOME path leaked into %s" % art_name)
            self.assertNotIn("secretuser", art,
                             "username leaked into %s" % art_name)

    def test_e2e_no_secret_survives_without_diffs(self):
        loki_dir = os.path.join(self.tmp, "proj", ".loki")
        out_dir = os.path.join(self.tmp, "out1")
        self._seed_loki(loki_dir, _ANTHROPIC, _GHP)
        self._run_generator(loki_dir, out_dir, include_diffs=False)
        self._assert_no_leak(out_dir, [
            ("anthropic-brief", _ANTHROPIC),
            ("ghp-summary", _GHP),
            ("db-password", "topsecretdbpass"),
        ])
        # Positive controls: prove the seeded fields actually reached the
        # chokepoint (an assertNotIn passes vacuously if the field never
        # entered the proof). The redaction MARKERS must be present, which
        # proves both "secret entered" and "redactor fired".
        proof_text = open(os.path.join(out_dir, "proof.json")).read()
        self.assertIn("[REDACTED:ANTHROPIC_KEY]", proof_text,
                      "anthropic key from brief did not reach the chokepoint")
        self.assertIn("[REDACTED:GITHUB_TOKEN]", proof_text,
                      "github token from council summary did not reach it")
        self.assertIn("[REDACTED]", proof_text,
                      "DB_PASSWORD value redaction marker missing")
        # redaction.applied invariant.
        d = json.load(open(os.path.join(out_dir, "proof.json")))
        self.assertIs(d["redaction"]["applied"], True)
        self.assertGreater(d["redaction"]["redactions_count"], 0)

    def test_e2e_no_secret_survives_with_diffs_in_git_repo(self):
        proj = os.path.join(self.tmp, "gitproj")
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out2")
        os.makedirs(proj)
        # Build a real git repo with a commit, then a working-tree change that
        # embeds a secret so --include-diffs has a patch to redact.
        def git(*a):
            subprocess.run(["git", "-C", proj, "-c", "user.email=t@t.test",
                            "-c", "user.name=tester"] + list(a),
                           capture_output=True, text=True, check=True)
        git("init")
        with open(os.path.join(proj, "config.py"), "w") as f:
            f.write("VALUE = 1\n")
        git("add", "config.py")
        git("commit", "-m", "init")
        # Modify with a secret in the diff body.
        with open(os.path.join(proj, "config.py"), "w") as f:
            f.write("VALUE = 1\nOPENAI_KEY = '%s'\n" % _OPENAI)
        git("add", "config.py")
        git("commit", "-m", "add key")
        self._seed_loki(loki_dir, _SLACK, _JWT)
        self._run_generator(loki_dir, out_dir, include_diffs=True)
        # The diff must be present (proof has a non-null diffs list) yet the
        # secret inside the patch must be redacted.
        d = json.load(open(os.path.join(out_dir, "proof.json")))
        self.assertIsNotNone(d["diffs"], "expected diffs with --include-diffs")
        self._assert_no_leak(out_dir, [
            ("slack-brief", _SLACK),
            ("jwt-summary", _JWT),
            ("openai-in-diff", _OPENAI),
        ])
        # Positive controls (see note in the no-diffs e2e): prove each seeded
        # field reached the chokepoint, including the secret inside the patch.
        proof_text = open(os.path.join(out_dir, "proof.json")).read()
        self.assertIn("[REDACTED:SLACK_TOKEN]", proof_text,
                      "slack token from brief did not reach the chokepoint")
        self.assertIn("[REDACTED:JWT]", proof_text,
                      "jwt from council summary did not reach the chokepoint")
        self.assertIn("[REDACTED:OPENAI_KEY]", proof_text,
                      "openai key in the diff body was not redacted")


class RedactionInvariantTests(unittest.TestCase):
    """redaction.applied always True; generator refuses to emit if bypassed."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-bypass-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _load_generator_module(self):
        spec = importlib.util.spec_from_file_location(
            "proof_generator_under_test", _GENERATOR)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def _make_args(self, mod, loki_dir, out_dir):
        import argparse
        return argparse.Namespace(
            loki_dir=loki_dir, out_dir=out_dir, include_diffs=False,
            run_id="bypass-001", loki_version="9.9.9", provider="claude",
            quiet=True)

    def test_redaction_applied_always_true(self):
        loki_dir = os.path.join(self.tmp, "p", ".loki")
        out_dir = os.path.join(self.tmp, "out")
        os.makedirs(loki_dir)
        mod = self._load_generator_module()
        mod.generate(self._make_args(mod, loki_dir, out_dir))
        d = json.load(open(os.path.join(out_dir, "proof.json")))
        self.assertIs(d["redaction"]["applied"], True)

    def test_generator_refuses_to_emit_when_redaction_bypassed_none_count(self):
        loki_dir = os.path.join(self.tmp, "p2", ".loki")
        out_dir = os.path.join(self.tmp, "out2")
        os.makedirs(loki_dir)
        mod = self._load_generator_module()
        # Patch the exact reference the generator holds (mod.proof_redact) so
        # the chokepoint returns a None count -> generator must refuse.
        orig = mod.proof_redact.redact_tree
        mod.proof_redact.redact_tree = lambda obj: (obj, None)
        try:
            with self.assertRaises(RuntimeError):
                mod.generate(self._make_args(mod, loki_dir, out_dir))
        finally:
            mod.proof_redact.redact_tree = orig
        # Nothing should have been written.
        self.assertFalse(os.path.exists(os.path.join(out_dir, "proof.json")))

    def test_generator_refuses_to_emit_when_redaction_returns_non_dict(self):
        loki_dir = os.path.join(self.tmp, "p3", ".loki")
        out_dir = os.path.join(self.tmp, "out3")
        os.makedirs(loki_dir)
        mod = self._load_generator_module()
        orig = mod.proof_redact.redact_tree
        mod.proof_redact.redact_tree = lambda obj: ("not a dict", 0)
        try:
            with self.assertRaises(RuntimeError):
                mod.generate(self._make_args(mod, loki_dir, out_dir))
        finally:
            mod.proof_redact.redact_tree = orig
        self.assertFalse(os.path.exists(os.path.join(out_dir, "proof.json")))


if __name__ == "__main__":
    unittest.main()
