"""tests/test_proof_html.py -- generated proof page is self-contained (R1).

Asserts the generated index.html:
  - contains NO external resource references (src=, <link href, @import,
    url(http, cdn., fonts.) EXCEPT the single github.com attribution href.
  - carries all the Tier1-4 schema fields. The shipped template renders
    client-side, so field values live in the embedded
    <script type="application/json" id="proof-data"> blob: this test extracts
    that blob, json.loads it (the generator escapes "<" as \\u003c which
    json.loads decodes natively), and asserts the schema fields are present.
  - exposes every Tier1-4 section container id the renderer targets.

Also exercises the server-side fallback renderer (_render_fallback_html)
directly to assert the key fields render as visible text when no template is
used.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GENERATOR = os.path.join(_REPO, "autonomy", "lib", "proof-generator.py")

# The only external href allowed in the page (tasteful attribution badge).
_ALLOWED_HREF = "github.com/asklokesh/loki-mode"

# Section container ids the renderer targets (template GENERATOR CONTRACT).
_SECTION_IDS = [
    "secTier1", "tier1Card", "costCard", "statRow", "filesCard",
    "councilCard", "gatesCard", "flaggedCard", "specCard", "provCard",
    "ctaCard",
]

# Frozen schema top-level fields that must appear in the embedded blob.
_SCHEMA_FIELDS = [
    "schema_version", "run_id", "generated_at", "loki_version", "started_at",
    "wall_clock_sec", "spec", "provider", "iterations", "files_changed",
    "diffs", "council", "quality_gates", "cost", "deployment", "redaction",
    "verification",
]


def _load_generator_module():
    spec = importlib.util.spec_from_file_location(
        "proof_generator_html_test", _GENERATOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _strip_allowed_href(html):
    """Prepare HTML for the external-ref scan.

    Removes HTML comments first (a comment cannot load an external resource,
    and the template's self-documentation comment literally lists the strings
    it forbids, e.g. "NO @import"), then strips the single allowlisted
    github.com/asklokesh/loki-mode attribution href so the scan does not
    false-positive on it.
    """
    no_comments = re.sub(r"<!--.*?-->", "", html, flags=re.DOTALL)
    return re.sub(
        r'https?://[^"\'\s>]*github\.com/asklokesh/loki-mode[^"\'\s>]*',
        "", no_comments)


class ExternalRefScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-html-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _generate(self, *, include_diffs=False, deployed_url=None):
        loki_dir = os.path.join(self.tmp, "p", ".loki")
        out_dir = os.path.join(self.tmp, "out")
        os.makedirs(os.path.join(loki_dir, "metrics", "efficiency"))
        os.makedirs(os.path.join(loki_dir, "council", "votes"))
        with open(os.path.join(loki_dir, "metrics", "efficiency",
                               "iteration-1.json"), "w") as f:
            json.dump({"cost_usd": 0.42, "input_tokens": 10,
                       "output_tokens": 5, "model": "claude-x"}, f)
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({"enabled": True, "verdicts": [{"verdict": "APPROVE"}]}, f)
        with open(os.path.join(loki_dir, "council", "votes", "r1.json"),
                  "w") as f:
            json.dump({"role": "principal", "vote": "APPROVE",
                       "summary": "ok"}, f)
        with open(os.path.join(loki_dir, "generated-prd.md"), "w") as f:
            f.write("A brief.")
        cmd = [sys.executable, _GENERATOR, "--loki-dir", loki_dir,
               "--out-dir", out_dir, "--run-id", "html-001", "--quiet"]
        if include_diffs:
            cmd.append("--include-diffs")
        env = dict(os.environ)
        env.pop("PRD_PATH", None)
        if deployed_url:
            env["LOKI_DEPLOYED_URL"] = deployed_url
        r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                           timeout=60)
        self.assertEqual(r.returncode, 0, "generator failed: %s" % r.stderr)
        html_path = os.path.join(out_dir, "index.html")
        return open(html_path, "r").read()

    def test_no_external_resource_refs(self):
        html = self._generate()
        scrubbed = _strip_allowed_href(html)
        forbidden = [
            # src= as an HTML tag attribute (loads an external resource), not a
            # JS variable named src. Anchored to a tag opener.
            ("tag src= attribute", r"<[a-zA-Z][^>]*\bsrc\s*="),
            ("<link", r"<link\b"),
            ("@import", r"@import"),
            ("url(http", r"url\(\s*['\"]?https?:"),
            ("cdn.", r"cdn\."),
            ("fonts.", r"fonts\."),
        ]
        for label, pat in forbidden:
            m = re.search(pat, scrubbed, re.IGNORECASE)
            self.assertIsNone(
                m, "external resource ref found (%s): ...%s..." % (
                    label, scrubbed[max(0, (m.start() - 30)):m.start() + 40]
                    if m else ""))
        # No http(s) URLs at all remain other than the allowlisted attribution.
        remaining = re.findall(r"https?://[^\s\"'<>)]+", scrubbed)
        self.assertEqual(
            remaining, [],
            "unexpected external URL(s) remain after allowlist: %r" % remaining)

    def test_attribution_href_present(self):
        html = self._generate()
        self.assertIn(_ALLOWED_HREF, html,
                      "attribution link should be present")

    def test_all_schema_fields_render_in_embedded_blob(self):
        html = self._generate()
        # Extract the proof-data blob. Anchor on type="application/json" so we
        # do not match the HTML comment that mentions <script id="proof-data">.
        m = re.search(
            r'<script[^>]*type="application/json"[^>]*id="proof-data"[^>]*>'
            r'(.*?)</script>',
            html, re.DOTALL)
        self.assertIsNotNone(m, "proof-data blob not found in page")
        blob = m.group(1).strip()
        data = json.loads(blob)
        for field in _SCHEMA_FIELDS:
            self.assertIn(field, data,
                          "schema field %r missing from embedded blob" % field)
        # Nested Tier-fields a skeptic checks.
        self.assertIn("usd", data["cost"])
        self.assertIn("count", data["files_changed"])
        self.assertIn("final_verdict", data["council"])
        self.assertIn("hash", data["verification"])
        self.assertIn("deployed_url", data["deployment"])

    def test_all_section_containers_present(self):
        html = self._generate()
        for sid in _SECTION_IDS:
            self.assertIn(
                'id="%s"' % sid, html,
                "section container id=%r missing from page" % sid)


class SocialHookAndNullCostTests(unittest.TestCase):
    """og:description carries the real run cost/diffstat/council, and an
    uncollected cost never renders '$0.00' anywhere."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-hook-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _generate(self, *, with_cost, tag):
        loki_dir = os.path.join(self.tmp, tag, ".loki")
        out_dir = os.path.join(self.tmp, "out-" + tag)
        os.makedirs(os.path.join(loki_dir, "council", "votes"))
        if with_cost:
            os.makedirs(os.path.join(loki_dir, "metrics", "efficiency"))
            with open(os.path.join(loki_dir, "metrics", "efficiency",
                                   "iteration-1.json"), "w") as f:
                json.dump({"cost_usd": 1.84, "input_tokens": 100,
                           "output_tokens": 20, "model": "claude-x"}, f)
        # Council with 3 reviewers, all APPROVE.
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({"enabled": True, "verdicts": [{"verdict": "APPROVE"}]}, f)
        for i in range(3):
            with open(os.path.join(loki_dir, "council", "votes",
                                   "r%d.json" % i), "w") as f:
                json.dump({"role": "reviewer-%d" % i, "vote": "APPROVE",
                           "summary": "ok"}, f)
        with open(os.path.join(loki_dir, "generated-prd.md"), "w") as f:
            f.write("A brief.")
        cmd = [sys.executable, _GENERATOR, "--loki-dir", loki_dir,
               "--out-dir", out_dir, "--run-id", "hook-" + tag, "--quiet"]
        env = dict(os.environ)
        env.pop("PRD_PATH", None)
        r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                           timeout=60)
        self.assertEqual(r.returncode, 0, "generator failed: %s" % r.stderr)
        return open(os.path.join(out_dir, "index.html"), "r").read()

    def _og_desc(self, html):
        m = re.search(
            r'<meta property="og:description" content="([^"]*)"', html)
        self.assertIsNotNone(m, "og:description meta not found")
        return m.group(1)

    def _tw_desc(self, html):
        m = re.search(
            r'<meta name="twitter:description" content="([^"]*)"', html)
        self.assertIsNotNone(m, "twitter:description meta not found")
        return m.group(1)

    def test_token_fully_substituted(self):
        for with_cost in (True, False):
            html = self._generate(with_cost=with_cost,
                                  tag="sub-%s" % with_cost)
            self.assertNotIn("__PROOF_OG_DESCRIPTION__", html,
                             "og token left un-substituted")

    def test_with_cost_og_has_real_number(self):
        html = self._generate(with_cost=True, tag="wc")
        og = self._og_desc(html)
        self.assertIn("$1.84", og)
        self.assertIn("3-of-3 reviewers approved", og)
        self.assertNotIn("$0.00", og)
        # twitter mirrors og.
        self.assertEqual(self._tw_desc(html), og)

    def test_without_cost_og_is_cost_free(self):
        html = self._generate(with_cost=False, tag="nc")
        og = self._og_desc(html)
        self.assertNotIn("$0.00", og)
        self.assertNotIn("$", og)  # cost clause dropped entirely
        self.assertIn("file", og)  # still has diffstat punch
        self.assertIn("3-of-3 reviewers approved", og)

    def test_without_cost_never_renders_dollar_zero(self):
        html = self._generate(with_cost=False, tag="z")
        # The credibility-blocking check: no "$0.00" or "0.00" anywhere in the
        # served page (og meta, cost card markup, JS branches).
        self.assertNotIn("$0.00", html)
        # proof.json must carry usd: null (the JS branches on it).
        out_dir = os.path.join(self.tmp, "out-z")
        d = json.load(open(os.path.join(out_dir, "proof.json")))
        self.assertIsNone(d["cost"]["usd"])


class FallbackRendererTests(unittest.TestCase):
    """Exercise the server-side fallback renderer directly: the Tier1-4 key
    fields must render as visible text."""

    def test_fallback_renders_key_fields_as_text(self):
        mod = _load_generator_module()
        proof = {
            "schema_version": "1.0",
            "run_id": "fallback-xyz",
            "generated_at": "2026-06-03T01:02:03Z",
            "loki_version": "7.9.0",
            "started_at": "2026-06-03T00:00:00Z",
            "wall_clock_sec": 123,
            "spec": {"source": "codebase-analysis", "brief": "a brief here"},
            "provider": {"name": "claude", "model": "claude-x"},
            "iterations": {"count": 2, "succeeded": 2, "failed": 0},
            "files_changed": {"count": 3, "insertions": 10, "deletions": 4,
                              "files": []},
            "diffs": None,
            "council": {"enabled": True, "final_verdict": "APPROVE",
                        "threshold": 3, "reviewers": [], "findings_link": None},
            "quality_gates": {"passed": 1, "total": 1, "gates": []},
            "cost": {"usd": 1.84, "input_tokens": 1000, "output_tokens": 200,
                     "cache_read_tokens": 5, "cache_creation_tokens": 3},
            "deployment": {"deployed_url": None, "public_url": None},
            "redaction": {"applied": True, "rules_version": "1.0",
                          "redactions_count": 0},
            "verification": {"hash": "abc123", "algo": "sha256",
                             "scope": "integrity"},
        }
        html = mod._render_fallback_html(proof)
        # Tier 2 hero: cost.
        self.assertIn("1.84", html)
        self.assertIn("$1.84", html)
        self.assertIn("1000", html)  # input tokens
        # Tier 4: provenance.
        self.assertIn("fallback-xyz", html)   # run id
        self.assertIn("7.9.0", html)          # loki version
        self.assertIn("abc123", html)         # integrity hash
        self.assertIn("claude-x", html)       # model
        # Tier 1.
        self.assertIn("123", html)            # wall clock
        # No external resource refs in the fallback either.
        scrubbed = _strip_allowed_href(html)
        self.assertIsNone(re.search(r"src\s*=", scrubbed, re.IGNORECASE))
        self.assertIsNone(re.search(r"<link\b", scrubbed, re.IGNORECASE))
        self.assertEqual(
            re.findall(r"https?://[^\s\"'<>)]+", scrubbed), [])

    def test_fallback_null_cost_not_dollar_zero(self):
        mod = _load_generator_module()
        proof = {
            "schema_version": "1.0", "run_id": "fb-null",
            "generated_at": "2026-06-03T01:02:03Z", "loki_version": "7.9.0",
            "started_at": "2026-06-03T00:00:00Z", "wall_clock_sec": 123,
            "spec": {"source": "codebase-analysis", "brief": "b"},
            "provider": {"name": "claude", "model": "claude-x"},
            "iterations": {"count": 2, "succeeded": 2, "failed": 0},
            "files_changed": {"count": 3, "insertions": 10, "deletions": 4,
                              "files": []},
            "diffs": None,
            "council": {"enabled": False, "final_verdict": "", "threshold": None,
                        "reviewers": [], "findings_link": None},
            "quality_gates": {"passed": 0, "total": 0, "gates": []},
            "cost": {"usd": None, "input_tokens": 1000, "output_tokens": 200,
                     "cache_read_tokens": 5, "cache_creation_tokens": 3},
            "deployment": {"deployed_url": None, "public_url": None},
            "redaction": {"applied": True, "rules_version": "1.0",
                          "redactions_count": 0},
            "verification": {"hash": "abc123", "algo": "sha256",
                             "scope": "integrity"},
        }
        html = mod._render_fallback_html(proof)
        # Never the credibility-killing "$0.00", never literal "$None".
        self.assertNotIn("$0.00", html)
        self.assertNotIn("$None", html)
        self.assertNotIn("None to run", html)
        self.assertIn("not recorded", html)


if __name__ == "__main__":
    unittest.main()
