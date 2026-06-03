"""
Tests for the R10 hub-install mechanism (agents/hub_install.py).

Covers:
  - install an agent manifest from a local fixture
  - install a template manifest from a local fixture (inline body + body_file)
  - install from a local git repo (file:// clone, no network)
  - manifest validation rejects malformed and unsafe input
  - path traversal in type/name is rejected
  - shadowing a built-in agent type / template name is rejected
  - no arbitrary code execution: a manifest with postinstall/scripts is
    installed as data, the hooks are ignored, and nothing runs
  - merged_agent_types / installed_*_list read paths

No network. Git path uses a local file:// repo built in a temp dir.
Run: python3 tests/test_hub_install.py   (or: pytest tests/test_hub_install.py)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Make agents/hub_install.py importable regardless of CWD.
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "hub_install", str(_REPO_ROOT / "agents" / "hub_install.py")
)
hub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hub)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _Sandbox:
    """Point LOKI_DIR at an isolated temp dir so installs never touch repo."""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-hubtest-")
        self._prev_loki = os.environ.get("LOKI_DIR")
        self._prev_target = os.environ.get("LOKI_TARGET_DIR")
        os.environ["LOKI_DIR"] = os.path.join(self.tmp, ".loki")
        os.environ["LOKI_TARGET_DIR"] = self.tmp

    def cleanup(self):
        for key, prev in (("LOKI_DIR", self._prev_loki), ("LOKI_TARGET_DIR", self._prev_target)):
            if prev is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prev
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)


def _write_manifest(dirpath: str, obj: dict, name: str = "manifest.json") -> str:
    p = os.path.join(dirpath, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    return p


_PASS = 0
_FAIL = 0


def check(cond, label):
    global _PASS, _FAIL
    if cond:
        _PASS += 1
        print(f"  PASS: {label}")
    else:
        _FAIL += 1
        print(f"  FAIL: {label}")


def expect_reject(fn, label):
    """Assert fn() raises ManifestError."""
    global _PASS, _FAIL
    try:
        fn()
    except hub.ManifestError:
        _PASS += 1
        print(f"  PASS: {label}")
        return
    except Exception as e:  # any other error is also a failure to install -- but be strict
        _FAIL += 1
        print(f"  FAIL: {label} (raised {type(e).__name__}, expected ManifestError)")
        return
    _FAIL += 1
    print(f"  FAIL: {label} (no error raised)")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_install_agent_local():
    print("test_install_agent_local")
    sb = _Sandbox()
    try:
        src = tempfile.mkdtemp(prefix="loki-agentsrc-")
        manifest = {
            "schema_version": 1,
            "kind": "agent",
            "type": "community-rust-pro",
            "name": "Rust Pro",
            "swarm": "engineering",
            "persona": "You are a Rust specialist.",
            "focus": ["rust", "tokio", "async"],
            "capabilities": "Rust, tokio, async, lifetimes",
        }
        _write_manifest(src, manifest)
        entry = hub.install_agent(src)
        check(entry["type"] == "community-rust-pro", "agent installed with correct type")
        check(entry["source"] == "hub-installed", "agent tagged hub-installed")
        listed = hub.installed_agent_list()
        check(any(a["type"] == "community-rust-pro" for a in listed), "agent appears in installed list")
        merged = hub.merged_agent_types()
        types = {a.get("type") for a in merged}
        check("community-rust-pro" in types, "installed agent unioned into merged_agent_types")
        check("eng-frontend" in types, "built-in agents still present in merged list")
    finally:
        sb.cleanup()


def test_install_template_local_inline():
    print("test_install_template_local_inline")
    sb = _Sandbox()
    try:
        src = tempfile.mkdtemp(prefix="loki-tplsrc-")
        manifest = {
            "schema_version": 1,
            "kind": "template",
            "name": "rust-cli-x",
            "label": "Rust CLI Tool",
            "description": "A CLI tool in Rust",
            "body": "# PRD: Rust CLI\n\n## Overview\nBuild a CLI.",
        }
        _write_manifest(src, manifest)
        meta = hub.install_template(src)
        check(meta["name"] == "rust-cli-x", "template installed with correct name")
        body_path = hub.installed_template_path("rust-cli-x")
        check(body_path is not None and os.path.exists(body_path), "template body file written")
        with open(body_path, encoding="utf-8") as f:
            check("Build a CLI." in f.read(), "template body content correct")
        listed = hub.installed_template_list()
        check(any(t["name"] == "rust-cli-x" for t in listed), "template in installed list")
    finally:
        sb.cleanup()


def test_install_template_body_file():
    print("test_install_template_body_file")
    sb = _Sandbox()
    try:
        src = tempfile.mkdtemp(prefix="loki-tplbf-")
        with open(os.path.join(src, "prd.md"), "w", encoding="utf-8") as f:
            f.write("# PRD from body_file\nContents here.")
        manifest = {
            "kind": "template",
            "name": "from-file-x",
            "label": "From File",
            "body_file": "prd.md",
        }
        _write_manifest(src, manifest)
        meta = hub.install_template(src)
        body_path = hub.installed_template_path("from-file-x")
        with open(body_path, encoding="utf-8") as f:
            check("Contents here." in f.read(), "body_file inlined correctly")
    finally:
        sb.cleanup()


def test_install_agent_from_git():
    print("test_install_agent_from_git")
    sb = _Sandbox()
    repo = tempfile.mkdtemp(prefix="loki-gitrepo-")
    try:
        manifest = {
            "kind": "agent",
            "type": "git-sourced-agent",
            "name": "Git Agent",
            "swarm": "community",
            "persona": "Persona from git.",
        }
        _write_manifest(repo, manifest)
        env = dict(os.environ)
        env["GIT_CONFIG_GLOBAL"] = os.path.join(repo, ".gitconfig-none")
        for args in (
            ["git", "init", "-q"],
            ["git", "config", "user.email", "t@t"],
            ["git", "config", "user.name", "t"],
            ["git", "add", "manifest.json"],
            ["git", "commit", "-q", "-m", "init"],
        ):
            subprocess.run(args, cwd=repo, check=True, capture_output=True, env=env)
        file_url = f"file://{repo}/.git"
        entry = hub.install_agent(file_url)
        check(entry["type"] == "git-sourced-agent", "agent installed from file:// git source")
    finally:
        sb.cleanup()
        import shutil

        shutil.rmtree(repo, ignore_errors=True)


def test_reject_malformed():
    print("test_reject_malformed")
    expect_reject(lambda: hub.validate_agent_manifest("not a dict"), "reject non-object agent manifest")
    expect_reject(lambda: hub.validate_agent_manifest({"type": "x"}), "reject agent missing persona")
    expect_reject(
        lambda: hub.validate_agent_manifest({"type": "x", "persona": "p", "focus": "notalist"}),
        "reject agent focus not a list",
    )
    expect_reject(
        lambda: hub.validate_agent_manifest({"type": "x", "persona": 123}),
        "reject agent persona wrong type",
    )
    expect_reject(
        lambda: hub.validate_agent_manifest({"kind": "template", "type": "x", "persona": "p"}),
        "reject wrong kind for agent",
    )
    expect_reject(
        lambda: hub.validate_template_manifest({"name": "x"}),
        "reject template missing body",
    )
    expect_reject(
        lambda: hub.validate_template_manifest({"name": "x", "body": "   "}),
        "reject template empty body",
    )
    expect_reject(
        lambda: hub.validate_agent_manifest({"type": "x", "persona": "p", "schema_version": 99}),
        "reject unsupported schema_version",
    )


def test_reject_path_traversal():
    print("test_reject_path_traversal")
    expect_reject(
        lambda: hub.validate_agent_manifest({"type": "../../etc/passwd", "persona": "p"}),
        "reject agent type with ..",
    )
    expect_reject(
        lambda: hub.validate_agent_manifest({"type": "a/b", "persona": "p"}),
        "reject agent type with slash",
    )
    expect_reject(
        lambda: hub.validate_agent_manifest({"type": "/abs", "persona": "p"}),
        "reject agent type absolute path",
    )
    expect_reject(
        lambda: hub.validate_agent_manifest({"type": "bad\x00name", "persona": "p"}),
        "reject agent type with null byte",
    )
    expect_reject(
        lambda: hub.validate_template_manifest({"name": "../evil", "body": "x"}),
        "reject template name with ..",
    )
    expect_reject(
        lambda: hub.validate_template_manifest({"name": "a/b", "body": "x"}),
        "reject template name with slash",
    )


def test_reject_builtin_shadow():
    print("test_reject_builtin_shadow")
    builtins = hub.builtin_agent_types()
    check(len(builtins) > 0, "builtin agent types discovered")
    if builtins:
        expect_reject(
            lambda: hub.validate_agent_manifest({"type": builtins[0], "persona": "evil"}),
            f"reject agent shadowing built-in {builtins[0]!r}",
        )
    tpls = hub.builtin_template_names()
    check(len(tpls) > 0, "builtin template names discovered")
    if tpls:
        expect_reject(
            lambda: hub.validate_template_manifest({"name": tpls[0], "body": "evil"}),
            f"reject template shadowing built-in {tpls[0]!r}",
        )


def test_no_code_execution():
    print("test_no_code_execution")
    sb = _Sandbox()
    try:
        src = tempfile.mkdtemp(prefix="loki-evilsrc-")
        sentinel = os.path.join(src, "PWNED")
        # A manifest carrying executable-looking fields. If any were run, the
        # sentinel file would be created. We assert it is NOT.
        manifest = {
            "kind": "agent",
            "type": "evil-agent",
            "name": "Evil",
            "swarm": "community",
            "persona": "ignore me",
            "postinstall": f"touch {sentinel}",
            "scripts": {"install": f"touch {sentinel}"},
            "exec": f"python3 -c \"open('{sentinel}','w').close()\"",
            "hooks": {"post": f"sh -c 'touch {sentinel}'"},
        }
        _write_manifest(src, manifest)
        entry = hub.install_agent(src)
        check(not os.path.exists(sentinel), "no sentinel created -> no code executed")
        check(
            set(entry.get("_ignored_executable_fields", [])) >= {"postinstall", "scripts", "exec", "hooks"},
            "executable-looking fields reported as ignored",
        )
        # The installed entry must NOT contain the executable fields.
        listed = hub.installed_agent_list()
        inst = next((a for a in listed if a["type"] == "evil-agent"), {})
        check("postinstall" not in inst and "scripts" not in inst, "executable fields stripped from stored entry")
    finally:
        sb.cleanup()


def test_reject_unknown_source():
    print("test_reject_unknown_source")
    expect_reject(lambda: hub.resolve_source("not://a/real/scheme"), "reject unrecognized source scheme")
    expect_reject(lambda: hub.resolve_source(""), "reject empty source")


def main():
    for fn in (
        test_install_agent_local,
        test_install_template_local_inline,
        test_install_template_body_file,
        test_install_agent_from_git,
        test_reject_malformed,
        test_reject_path_traversal,
        test_reject_builtin_shadow,
        test_no_code_execution,
        test_reject_unknown_source,
    ):
        fn()
    print(f"\nRESULT: {_PASS} passed, {_FAIL} failed")
    return 1 if _FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
