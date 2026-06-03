"""Tests for the R8 shareable-team-assets bundler (autonomy/lib/assets_bundle.py).

Covers:
  - export produces a tarball with a manifest
  - import restores assets to their mapped roots
  - redaction strips seeded secrets from EVERY file type (md, jsonl, json)
    via the reused proof_redact chokepoint
  - round-trip fidelity (non-secret content survives export -> import)
  - no-PII: absolute home/repo paths collapse, no secrets leak
  - learnings JSONL merge-with-dedupe on import into a non-empty target
  - path-traversal members are rejected on import

All mock / local. No network, no paid calls.
"""

import json
import os
import sys
import tarfile
import tempfile
import unittest

# Import the module under test from autonomy/lib.
_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(_HERE, "..", "autonomy", "lib")
sys.path.insert(0, _LIB)

import assets_bundle  # noqa: E402

SECRET_ANTHROPIC = "sk-ant-" + "A" * 40
SECRET_GITHUB = "ghp_" + "B" * 36
SECRET_OPENAI = "sk-" + "C" * 40


class AssetsBundleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-assets-test-")
        # Source layout: a HOME with cross-project learnings, a repo with
        # agents+templates, a project with .loki/memory + council + wiki.
        self.src_home = os.path.join(self.tmp, "src_home")
        self.src_repo = os.path.join(self.tmp, "src_repo")
        self.src_project = self.src_repo  # project == repo in normal use
        self._seed_sources()

        # Destination (fresh clone) layout.
        self.dst_home = os.path.join(self.tmp, "dst_home")
        self.dst_repo = os.path.join(self.tmp, "dst_repo")
        self.dst_project = self.dst_repo
        os.makedirs(self.dst_repo, exist_ok=True)
        os.makedirs(self.dst_home, exist_ok=True)

        self.bundle = os.path.join(self.tmp, "team-assets.tgz")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, path, content):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    def _seed_sources(self):
        # learnings JSONL: secret in a value, absolute path in another.
        learn = os.path.join(self.src_home, ".loki", "learnings", "patterns.jsonl")
        self._write(
            learn,
            json.dumps(
                {
                    "description": "Use api_key=" + SECRET_OPENAI + " for X",
                    "project": "demo",
                    "path": os.path.join(self.src_home, "git", "demo"),
                }
            )
            + "\n"
            + json.dumps({"description": "Plain learning, no secret", "project": "demo"})
            + "\n",
        )
        # memory semantic JSON: secret in nested value.
        mem = os.path.join(
            self.src_project, ".loki", "memory", "semantic", "patterns.json"
        )
        self._write(
            mem,
            json.dumps(
                {
                    "patterns": [
                        {"name": "auth", "note": "token: " + SECRET_GITHUB},
                        {"name": "clean", "note": "nothing secret here"},
                    ]
                }
            ),
        )
        # agents registry JSON (team-edited).
        agents = os.path.join(self.src_repo, "agents", "types.json")
        self._write(
            agents,
            json.dumps(
                [{"type": "custom-x", "swarm": "engineering", "name": "Custom X"}]
            ),
        )
        # templates markdown: secret embedded in prose.
        tmpl = os.path.join(self.src_repo, "templates", "saas-starter.md")
        self._write(
            tmpl,
            "# SaaS Starter\n\nSet ANTHROPIC_API_KEY="
            + SECRET_ANTHROPIC
            + " then run.\n\nDeploy under "
            + os.path.join(self.src_home, "projects", "saas")
            + "\n",
        )
        # council config JSON.
        council = os.path.join(self.src_project, ".loki", "council", "config.json")
        self._write(
            council,
            json.dumps({"reviewers": 3, "models": ["opus", "opus", "sonnet"]}),
        )
        # wiki markdown (opt-in).
        wiki = os.path.join(self.src_project, ".loki", "wiki", "Home.md")
        self._write(wiki, "# Wiki\n\nGITHUB_TOKEN=" + SECRET_GITHUB + "\n")

    def _export(self, categories):
        return assets_bundle.export_bundle(
            self.bundle,
            home=self.src_home,
            repo_root=self.src_repo,
            project_dir=self.src_project,
            categories=categories,
        )

    def _bundle_text(self):
        """Concatenate every text member of the bundle for leak scanning."""
        chunks = []
        with tarfile.open(self.bundle, "r:gz") as tar:
            for m in tar.getmembers():
                if m.isfile():
                    f = tar.extractfile(m)
                    if f:
                        chunks.append(f.read().decode("utf-8", errors="replace"))
        return "\n".join(chunks)

    # --- export -------------------------------------------------------------

    def test_export_produces_bundle_with_manifest(self):
        manifest = self._export(assets_bundle.DEFAULT_CATEGORIES)
        self.assertTrue(os.path.isfile(self.bundle))
        self.assertEqual(manifest["schema_version"], assets_bundle.SCHEMA_VERSION)
        self.assertIn("learnings", manifest["categories"])
        self.assertIn("memory", manifest["categories"])
        self.assertIn("agents", manifest["categories"])
        self.assertIn("templates", manifest["categories"])
        self.assertIn("council", manifest["categories"])
        # manifest is the first member, then assets/*.
        with tarfile.open(self.bundle, "r:gz") as tar:
            names = tar.getnames()
        self.assertIn("manifest.json", names)
        self.assertTrue(any(n.startswith("assets/") for n in names))

    def test_manifest_records_redaction_rules_version(self):
        manifest = self._export(assets_bundle.DEFAULT_CATEGORIES)
        import proof_redact

        self.assertEqual(
            manifest["redaction_rules_version"], proof_redact.RULES_VERSION
        )

    def test_wiki_optin(self):
        manifest = self._export(assets_bundle.DEFAULT_CATEGORIES)
        self.assertNotIn("wiki", manifest["categories"])
        manifest2 = self._export(assets_bundle.DEFAULT_CATEGORIES + ["wiki"])
        self.assertIn("wiki", manifest2["categories"])

    # --- redaction (every file type) ---------------------------------------

    def test_redaction_strips_secrets_from_all_file_types(self):
        self._export(assets_bundle.DEFAULT_CATEGORIES + ["wiki"])
        text = self._bundle_text()
        # No seeded secret survives, in ANY file type.
        self.assertNotIn(SECRET_ANTHROPIC, text)  # md template
        self.assertNotIn(SECRET_OPENAI, text)  # jsonl learnings
        self.assertNotIn(SECRET_GITHUB, text)  # json memory + md wiki
        # Redaction markers are present (proof_redact replacements).
        self.assertIn("REDACTED", text)

    def test_redaction_collapses_absolute_paths(self):
        self._export(assets_bundle.DEFAULT_CATEGORIES)
        text = self._bundle_text()
        # The src_home absolute path must not appear verbatim in the bundle.
        self.assertNotIn(self.src_home, text)

    def test_manifest_counts_structured_redactions(self):
        manifest = self._export(assets_bundle.DEFAULT_CATEGORIES)
        # At least the JSON memory token + JSONL learnings token are counted.
        self.assertGreaterEqual(manifest["redactions"], 2)

    # --- import / round-trip -----------------------------------------------

    def test_import_restores_assets_to_mapped_roots(self):
        self._export(assets_bundle.DEFAULT_CATEGORIES + ["wiki"])
        result = assets_bundle.import_bundle(
            self.bundle,
            home=self.dst_home,
            target_repo=self.dst_repo,
            target_project=self.dst_project,
        )
        self.assertEqual(result["schema_version"], assets_bundle.SCHEMA_VERSION)
        # learnings -> dst_home/.loki/learnings
        self.assertTrue(
            os.path.isfile(
                os.path.join(self.dst_home, ".loki", "learnings", "patterns.jsonl")
            )
        )
        # memory -> dst_project/.loki/memory
        self.assertTrue(
            os.path.isfile(
                os.path.join(
                    self.dst_project,
                    ".loki",
                    "memory",
                    "semantic",
                    "patterns.json",
                )
            )
        )
        # agents -> dst_repo/agents
        self.assertTrue(
            os.path.isfile(os.path.join(self.dst_repo, "agents", "types.json"))
        )
        # templates -> dst_repo/templates
        self.assertTrue(
            os.path.isfile(
                os.path.join(self.dst_repo, "templates", "saas-starter.md")
            )
        )
        # council -> dst_project/.loki/council
        self.assertTrue(
            os.path.isfile(
                os.path.join(self.dst_project, ".loki", "council", "config.json")
            )
        )
        # wiki -> dst_project/.loki/wiki
        self.assertTrue(
            os.path.isfile(
                os.path.join(self.dst_project, ".loki", "wiki", "Home.md")
            )
        )

    def test_roundtrip_fidelity_nonsecret_content(self):
        self._export(assets_bundle.DEFAULT_CATEGORIES)
        assets_bundle.import_bundle(
            self.bundle,
            home=self.dst_home,
            target_repo=self.dst_repo,
            target_project=self.dst_project,
        )
        # Non-secret agent registry content survives intact.
        with open(os.path.join(self.dst_repo, "agents", "types.json")) as f:
            agents = json.load(f)
        self.assertEqual(agents[0]["type"], "custom-x")
        # Non-secret council config survives intact.
        with open(
            os.path.join(self.dst_project, ".loki", "council", "config.json")
        ) as f:
            council = json.load(f)
        self.assertEqual(council["reviewers"], 3)
        # Non-secret learning line survives.
        with open(
            os.path.join(self.dst_home, ".loki", "learnings", "patterns.jsonl")
        ) as f:
            body = f.read()
        self.assertIn("Plain learning, no secret", body)

    def test_imported_assets_contain_no_secrets(self):
        self._export(assets_bundle.DEFAULT_CATEGORIES + ["wiki"])
        assets_bundle.import_bundle(
            self.bundle,
            home=self.dst_home,
            target_repo=self.dst_repo,
            target_project=self.dst_project,
        )
        # Walk the entire destination and assert no seeded secret survived.
        leaked = []
        for root in (self.dst_home, self.dst_repo):
            for dirpath, _d, files in os.walk(root):
                for name in files:
                    p = os.path.join(dirpath, name)
                    with open(p, "r", encoding="utf-8", errors="replace") as f:
                        c = f.read()
                    for sec in (SECRET_ANTHROPIC, SECRET_OPENAI, SECRET_GITHUB):
                        if sec in c:
                            leaked.append((p, sec))
        self.assertEqual(leaked, [], "secrets leaked into imported assets: %r" % leaked)

    # --- merge semantics ----------------------------------------------------

    def test_learnings_merge_dedupes(self):
        self._export(["learnings"])
        # Seed the destination with a pre-existing learning that also appears
        # in the bundle (the "Plain learning" line) plus a unique one.
        dst_learn = os.path.join(
            self.dst_home, ".loki", "learnings", "patterns.jsonl"
        )
        self._write(
            dst_learn,
            json.dumps({"description": "Plain learning, no secret", "project": "demo"})
            + "\n"
            + json.dumps({"description": "Pre-existing unique", "project": "demo"})
            + "\n",
        )
        result = assets_bundle.import_bundle(
            self.bundle,
            home=self.dst_home,
            target_repo=self.dst_repo,
            target_project=self.dst_project,
            merge=True,
        )
        # import_bundle reports the realpath-resolved dest (security: it
        # validates the final resolved path is inside the restore root).
        self.assertIn(os.path.realpath(dst_learn), result["merged"])
        with open(dst_learn) as f:
            lines = [ln for ln in f.read().splitlines() if ln.strip()]
        descs = [json.loads(ln)["description"] for ln in lines]
        # The shared "Plain learning" appears exactly once (deduped).
        self.assertEqual(descs.count("Plain learning, no secret"), 1)
        # Pre-existing unique is preserved.
        self.assertIn("Pre-existing unique", descs)

    def test_no_merge_overwrites(self):
        self._export(["learnings"])
        dst_learn = os.path.join(
            self.dst_home, ".loki", "learnings", "patterns.jsonl"
        )
        self._write(dst_learn, json.dumps({"description": "OLD"}) + "\n")
        result = assets_bundle.import_bundle(
            self.bundle,
            home=self.dst_home,
            target_repo=self.dst_repo,
            target_project=self.dst_project,
            merge=False,
        )
        self.assertIn(os.path.realpath(dst_learn), result["restored"])
        with open(dst_learn) as f:
            body = f.read()
        self.assertNotIn("OLD", body)

    def test_import_rejects_absolute_path_escape(self):
        # SECURITY regression: a malicious bundle member whose sub_rel resolves
        # to an absolute path outside the restore root (e.g.
        # "assets/council//abs/path") must be SKIPPED, never written. The earlier
        # member-name traversal test missed this because os.path.join(root, abs)
        # silently discards root.
        import tarfile, io
        evil_target = os.path.join(self.tmp, "ESCAPED_PWNED.txt")
        evil_bundle = os.path.join(self.tmp, "evil.tgz")
        with tarfile.open(evil_bundle, "w:gz") as tar:
            mf = b'{"schema_version":"1.0"}'
            ti = tarfile.TarInfo("manifest.json"); ti.size = len(mf)
            tar.addfile(ti, io.BytesIO(mf))
            payload = b"PWNED"
            ti2 = tarfile.TarInfo("assets/council/" + evil_target)
            ti2.size = len(payload)
            tar.addfile(ti2, io.BytesIO(payload))
        result = assets_bundle.import_bundle(
            evil_bundle, home=self.dst_home, target_repo=self.dst_repo,
            target_project=self.dst_project, merge=False,
        )
        self.assertFalse(os.path.exists(evil_target),
                         "absolute-path escape wrote a file outside the root")
        self.assertTrue(any("ESCAPED_PWNED" in s for s in result["skipped"]),
                        "the escaping member must be skipped")

    # --- security -----------------------------------------------------------

    def test_path_traversal_member_rejected(self):
        # Craft a malicious bundle with a ../ member and assert import skips it.
        malicious = os.path.join(self.tmp, "evil.tgz")
        payload = b'{"x":1}'
        with tarfile.open(malicious, "w:gz") as tar:
            minfo = tarfile.TarInfo("manifest.json")
            mbytes = json.dumps({"schema_version": "1.0"}).encode()
            minfo.size = len(mbytes)
            import io

            tar.addfile(minfo, io.BytesIO(mbytes))
            evil = tarfile.TarInfo("assets/../../escape.json")
            evil.size = len(payload)
            tar.addfile(evil, io.BytesIO(payload))
        result = assets_bundle.import_bundle(
            malicious,
            home=self.dst_home,
            target_repo=self.dst_repo,
            target_project=self.dst_project,
        )
        self.assertIn("assets/../../escape.json", result["skipped"])
        self.assertFalse(
            os.path.exists(os.path.join(self.tmp, "escape.json"))
        )

    def test_originals_not_modified(self):
        # Export must not mutate source files on disk.
        tmpl = os.path.join(self.src_repo, "templates", "saas-starter.md")
        before = open(tmpl).read()
        self._export(assets_bundle.DEFAULT_CATEGORIES)
        after = open(tmpl).read()
        self.assertEqual(before, after)
        self.assertIn(SECRET_ANTHROPIC, after)  # original still has the secret


if __name__ == "__main__":
    unittest.main(verbosity=2)
