"""Regression tests for magic/core extractors.

Covers two bugs reported in the v6.76.1 honest audit:

1. DesignTokens.extract_from_codebase() returned 0 colors / 0 spacing when
   run against a generic project layout, because its globs were hardcoded
   to loki-mode paths (web-app/, dashboard-ui/).

2. _extract_compound_name() produced DashboardIncludesNavigation from
   the phrase "dashboard includes navigation", because "includes" was
   not a stop word. Also produced NavigationSidebarSearchBar by spanning
   two unrelated components.

Run with: python3 -m pytest tests/test_magic_extractors.py -v
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from magic.core.design_tokens import DesignTokens  # noqa: E402
from magic.core.prd_scanner import _extract_compound_name, scan_prd  # noqa: E402
from magic.core.memory_bridge import (  # noqa: E402
    capture_component_generation,
    capture_iteration_compound,
    recall_similar_components,
)


def test_design_tokens_extracts_from_generic_project(tmp_path):
    """Given a project with src/index.css and src/Button.tsx at non-loki
    paths, the extractor must still pick up colors and spacing."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "index.css").write_text(
        """
        :root {
          --color-primary: #553DE9;
          --color-accent: #10B981;
          --space-md: 16px;
        }
        .btn { background: #553DE9; padding: 8px 16px; border-radius: 8px; }
        """
    )
    (tmp_path / "src" / "Button.tsx").write_text(
        """
        export const Button = () => (
          <button className="p-4 m-2 bg-[#553DE9] rounded-md">Click</button>
        );
        """
    )

    tokens = DesignTokens(project_dir=str(tmp_path))
    observed = tokens.extract_from_codebase()

    assert observed["colors"], f"expected colors, got {observed}"
    # CSS var extraction should find color-primary
    assert "color-primary" in observed["colors"]
    assert observed["colors"]["color-primary"].upper() == "#553DE9"
    # Tailwind p-4 => 16px spacing
    assert observed["spacing"], f"expected spacing, got {observed}"


def test_design_tokens_excludes_node_modules(tmp_path):
    """node_modules content must not contaminate the extracted tokens."""
    nm = tmp_path / "node_modules" / "some-pkg"
    nm.mkdir(parents=True)
    (nm / "style.css").write_text(":root { --color-evil: #FF0000; }")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.css").write_text(":root { --color-good: #00FF00; }")

    observed = DesignTokens(project_dir=str(tmp_path)).extract_from_codebase()
    assert "color-good" in observed["colors"]
    assert "color-evil" not in observed["colors"]


def test_prd_scanner_rejects_includes_as_modifier():
    """'includes' is a linking verb, not a descriptor -- it must not end
    up in a compound name."""
    name = _extract_compound_name(
        "dashboard includes navigation", "navigation", "Navigation"
    )
    assert name == "Navigation", f"got {name}"


def test_prd_scanner_stops_at_another_component_keyword():
    """In 'navigation sidebar search bar', 'search bar' should produce
    'SearchBar' -- not 'NavigationSidebarSearchBar'. 'sidebar' is another
    distinct component, so modifier scanning must stop there."""
    name = _extract_compound_name(
        "navigation sidebar search bar", "search bar", "SearchBar"
    )
    assert name == "SearchBar", f"got {name}"


def test_prd_scanner_keeps_legitimate_modifiers():
    """Legit modifiers like 'submit' before 'button' must still compound."""
    name = _extract_compound_name(
        "add a submit button", "button", "Button"
    )
    assert name == "SubmitButton", f"got {name}"


def test_prd_scanner_end_to_end_no_noise():
    """Full scan over a short PRD should produce clean component names."""
    prd = (
        "The dashboard includes navigation. "
        "Add a submit button. "
        "The navigation sidebar has a search bar."
    )
    detected = scan_prd(prd)
    names = [d["name"] for d in detected]
    assert "DashboardIncludesNavigation" not in names
    assert "NavigationSidebarSearchBar" not in names
    # Expected clean components
    assert "SubmitButton" in names or "Button" in names
    assert "SearchBar" in names
    assert "Navigation" in names or "Sidebar" in names


def test_memory_bridge_happy_path_store_and_recall(tmp_path):
    """Store an episode, then recall it. Verifies bridge uses real
    MemoryEngine API (store_episode(trace) / retrieve_relevant(context))."""
    project = str(tmp_path)
    result = capture_component_generation(
        project_dir=project,
        component_name="SubmitButton",
        spec_path=str(tmp_path / ".loki" / "magic" / "specs" / "SubmitButton.md"),
        targets=["tsx", "css"],
        debate_result={"critiques": [{}, {}, {}, {}], "consensus": True, "blocks": []},
        iteration=1,
        duration_seconds=7.3,
    )
    assert result["stored"] is True, f"expected stored=True, got {result}"

    recalled = recall_similar_components(
        project, tags=["magic"], query="magic component generation"
    )
    assert len(recalled) >= 1, f"expected to recall stored episode, got {recalled}"


def test_mcp_magic_tools_register():
    """All 7 magic MCP tools register cleanly onto a FastMCP-compatible stub."""
    from mcp.magic_tools import register_magic_tools, _TOOLS

    class FakeMCP:
        def __init__(self):
            self.registered = []
        def tool(self):
            def decorator(fn):
                self.registered.append(fn.__name__)
                return fn
            return decorator

    mock = FakeMCP()
    names = register_magic_tools(mock)
    assert len(names) == len(_TOOLS), f"expected {len(_TOOLS)}, got {len(names)}"
    assert "loki_magic_generate" in names
    assert "loki_magic_debate" in names


def test_mcp_magic_tools_callable(tmp_path):
    """Magic MCP tools return structured {ok: bool, ...} dicts when called directly."""
    import os
    from mcp.magic_tools import (
        loki_magic_list, loki_magic_stats, loki_magic_tokens_extract,
    )
    orig = os.getcwd()
    try:
        os.chdir(tmp_path)
        assert loki_magic_list().get("ok") is True
        assert "total" in loki_magic_stats()
        assert "colors" in loki_magic_tokens_extract()
    finally:
        os.chdir(orig)


def test_memory_bridge_compound_records_stable_patterns(tmp_path):
    """With a registry of 3+ passing components in a tag, compound must
    record a semantic pattern."""
    import os
    reg_dir = tmp_path / ".loki" / "magic"
    os.makedirs(reg_dir, exist_ok=True)
    import json as _json
    (reg_dir / "registry.json").write_text(_json.dumps({
        "components": [
            {"name": "Btn1", "tags": ["form", "button"], "debate_passed": True},
            {"name": "Btn2", "tags": ["form", "button"], "debate_passed": True},
            {"name": "Btn3", "tags": ["form", "button"], "debate_passed": True},
            {"name": "Btn4", "tags": ["form"], "debate_passed": False},
        ],
    }))
    compound = capture_iteration_compound(str(tmp_path), iteration=2)
    assert compound["recorded"] is True, compound
    assert "button" in compound["stable_tags"]
    assert compound["patterns_stored"], "expected at least one pattern stored"


if __name__ == "__main__":
    # Allow running without pytest
    import tempfile
    import traceback

    failures = 0

    with tempfile.TemporaryDirectory() as td:
        try:
            test_design_tokens_extracts_from_generic_project(Path(td))
            print("PASS test_design_tokens_extracts_from_generic_project")
        except Exception:
            traceback.print_exc()
            failures += 1

    with tempfile.TemporaryDirectory() as td:
        try:
            test_design_tokens_excludes_node_modules(Path(td))
            print("PASS test_design_tokens_excludes_node_modules")
        except Exception:
            traceback.print_exc()
            failures += 1

    for fn in [
        test_prd_scanner_rejects_includes_as_modifier,
        test_prd_scanner_stops_at_another_component_keyword,
        test_prd_scanner_keeps_legitimate_modifiers,
        test_prd_scanner_end_to_end_no_noise,
    ]:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            traceback.print_exc()
            failures += 1

    try:
        test_mcp_magic_tools_register()
        print("PASS test_mcp_magic_tools_register")
    except Exception:
        traceback.print_exc()
        failures += 1

    with tempfile.TemporaryDirectory() as td:
        try:
            test_mcp_magic_tools_callable(Path(td))
            print("PASS test_mcp_magic_tools_callable")
        except Exception:
            traceback.print_exc()
            failures += 1

    for fn in [
        test_memory_bridge_happy_path_store_and_recall,
        test_memory_bridge_compound_records_stable_patterns,
    ]:
        with tempfile.TemporaryDirectory() as td:
            try:
                fn(Path(td))
                print(f"PASS {fn.__name__}")
            except Exception:
                traceback.print_exc()
                failures += 1

    sys.exit(1 if failures else 0)
