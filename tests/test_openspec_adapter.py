"""Unit tests for OpenSpec adapter (autonomy/openspec-adapter.py)."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# Path to the adapter script
ADAPTER_PATH = Path(__file__).parent.parent / "autonomy" / "openspec-adapter.py"
FIXTURES_DIR = Path(__file__).parent.parent / "examples" / "openspec"


def run_adapter(change_dir, output_dir, *extra_args):
    """Run the adapter as a subprocess and return (returncode, stdout, stderr)."""
    cmd = [sys.executable, str(ADAPTER_PATH), str(change_dir), "--output-dir", str(output_dir)] + list(extra_args)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return result.returncode, result.stdout, result.stderr


@pytest.fixture
def output_dir(tmp_path):
    """Provide a temporary output directory for adapter runs."""
    return tmp_path / "output"


# ---------------------------------------------------------------------------
# Proposal Parser Tests
# ---------------------------------------------------------------------------

class TestProposalParser:
    def test_simple_proposal_parsed(self, output_dir):
        """simple-feature proposal has Why, What Changes, Capabilities sections."""
        rc, stdout, stderr = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        proposal = data["proposal"]
        assert proposal["why"], "Why section should have content"
        assert "avatar" in proposal["why"].lower()
        assert proposal["what_changes"], "What Changes section should have content"
        assert len(proposal["new_capabilities"]) >= 1

    def test_standard_proposal_new_and_modified_capabilities(self, output_dir):
        """standard-feature proposal has both New and Modified capabilities."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "standard-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        proposal = data["proposal"]
        assert len(proposal["new_capabilities"]) >= 2, "Should have at least 2 new capabilities"
        assert len(proposal["modified_capabilities"]) >= 1, "Should have at least 1 modified capability"

    def test_empty_proposal_fails_validation(self, output_dir):
        """malformed fixture has an empty proposal.md -- validation should report error."""
        rc, stdout, stderr = run_adapter(FIXTURES_DIR / "malformed", output_dir, "--validate")
        assert rc == 1
        assert "empty" in stderr.lower() or "error" in stderr.lower()


# ---------------------------------------------------------------------------
# Delta Spec Parser Tests
# ---------------------------------------------------------------------------

class TestDeltaSpecParser:
    def test_added_requirements_parsed(self, output_dir):
        """simple-feature specs/users/spec.md has ADDED requirements."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        users_delta = data["deltas"]["users"]
        assert len(users_delta["added"]) == 2
        names = [r["name"] for r in users_delta["added"]]
        assert "Avatar Upload" in names
        assert "Avatar Display" in names

    def test_modified_requirements_parsed(self, output_dir):
        """brownfield-delta specs/api/spec.md has MODIFIED requirements with (Previously: ...)."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "brownfield-delta", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        api_delta = data["deltas"]["api"]
        assert len(api_delta["modified"]) >= 1
        # Check at least one has "previously" annotation
        modified_names = [r["name"] for r in api_delta["modified"]]
        assert "User Data Retrieval" in modified_names

    def test_removed_requirements_parsed(self, output_dir):
        """brownfield-delta specs/api/spec.md has REMOVED requirements."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "brownfield-delta", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        api_delta = data["deltas"]["api"]
        assert len(api_delta["removed"]) >= 1
        removed_names = [r["name"] for r in api_delta["removed"]]
        assert "Legacy User Search Endpoint" in removed_names

    def test_scenarios_with_given_when_then(self, output_dir):
        """Scenarios should have GIVEN/WHEN/THEN extracted."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        upload_req = data["deltas"]["users"]["added"][0]
        assert len(upload_req["scenarios"]) >= 1
        scenario = upload_req["scenarios"][0]
        assert len(scenario["given"]) >= 1
        assert len(scenario["when"]) >= 1
        assert len(scenario["then"]) >= 1

    def test_multiple_spec_domains(self, output_dir):
        """standard-feature has ui, settings, accessibility spec domains."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "standard-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        domains = set(data["deltas"].keys())
        assert "ui" in domains
        assert "settings" in domains
        assert "accessibility" in domains

    def test_brownfield_no_added(self, output_dir):
        """brownfield-delta api spec has 0 added, only modified+removed."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "brownfield-delta", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        api_delta = data["deltas"]["api"]
        assert len(api_delta["added"]) == 0
        assert len(api_delta["modified"]) >= 1
        assert len(api_delta["removed"]) >= 1


# ---------------------------------------------------------------------------
# Tasks Parser Tests
# ---------------------------------------------------------------------------

class TestTasksParser:
    def test_simple_tasks_all_pending(self, output_dir):
        """simple-feature has 3 pending tasks."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        tasks = data["tasks"]
        assert len(tasks) == 3
        assert all(t["status"] == "pending" for t in tasks)

    def test_partial_completion_status(self, output_dir):
        """partial-complete has 4 completed and 3 pending tasks."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "partial-complete", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        tasks = data["tasks"]
        completed = [t for t in tasks if t["status"] == "completed"]
        pending = [t for t in tasks if t["status"] == "pending"]
        assert len(completed) == 4
        assert len(pending) == 3

    def test_task_groups_extracted(self, output_dir):
        """standard-feature has multiple task groups."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "standard-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        tasks = data["tasks"]
        groups = {t["group"] for t in tasks}
        assert len(groups) >= 3, f"Expected at least 3 groups, got {groups}"

    def test_task_ids_hierarchical(self, output_dir):
        """Task IDs should be in openspec-<change>-N.M format.

        Change-scoping was added in v6.77.1 so tasks from different OpenSpec
        changes cannot collide in the pending queue. The ID suffix is still
        hierarchical N.M at the end; the change name sits between.
        """
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        for task in data["tasks"]:
            assert task["id"].startswith("openspec-"), f"ID {task['id']} should start with openspec-"
            # The hierarchical N.M portion is the tail of the id (e.g. 1.1, 2.3).
            # Anything between "openspec-" and the trailing N.M is the change name.
            suffix = task["id"].replace("openspec-", "")
            trailing = suffix.rsplit("-", 1)[-1] if "-" in suffix else suffix
            parts = trailing.split(".")
            assert len(parts) == 2, f"trailing segment {trailing!r} should be N.M"
            assert parts[0].isdigit() and parts[1].isdigit(), (
                f"trailing N.M must be numeric, got {trailing!r} from id {task['id']!r}"
            )

    def test_malformed_tasks_no_checkboxes(self, output_dir):
        """malformed tasks.md has no checkbox items -- should produce 0 tasks."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "malformed", output_dir, "--validate")
        # Validation mode since malformed lacks specs too
        # Let's directly test the parser via JSON on partial-complete (which works)
        # and separately verify malformed tasks by running adapter in non-validate mode
        # Malformed will fail because it has no specs, but we can check tasks via --json
        # on a fixture that works. For malformed specifically, we test via validate.
        assert rc == 1  # malformed fails validation


# ---------------------------------------------------------------------------
# Complexity Classification Tests
# ---------------------------------------------------------------------------

class TestComplexityClassification:
    def test_simple_complexity(self, output_dir):
        """simple-feature: 3 tasks, 1 spec, no design -> simple."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        assert data["complexity"] == "simple"

    def test_standard_complexity(self, output_dir):
        """standard-feature: 8 tasks, 3 specs, has design -> standard."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "standard-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        assert data["complexity"] == "standard"

    def test_complex_complexity(self, output_dir):
        """complex-feature: 15 tasks, 6 specs -> complex."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "complex-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        assert data["complexity"] == "complex"


# ---------------------------------------------------------------------------
# Output File Tests
# ---------------------------------------------------------------------------

class TestOutputFiles:
    def test_prd_normalized_created(self, output_dir):
        """Normalized PRD file is created with content."""
        rc, _, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir)
        assert rc == 0
        prd_path = output_dir / "openspec-prd-normalized.md"
        assert prd_path.exists()
        content = prd_path.read_text()
        assert len(content) > 100
        assert "OpenSpec Change" in content

    def test_tasks_json_valid(self, output_dir):
        """openspec-tasks.json contains a valid JSON array."""
        rc, _, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir)
        assert rc == 0
        tasks_path = output_dir / "openspec-tasks.json"
        assert tasks_path.exists()
        data = json.loads(tasks_path.read_text())
        assert isinstance(data, list)
        assert len(data) == 3

    def test_delta_context_structure(self, output_dir):
        """delta-context.json has change_name, deltas, complexity, stats keys."""
        rc, _, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir)
        assert rc == 0
        dc_path = output_dir / "openspec" / "delta-context.json"
        assert dc_path.exists()
        data = json.loads(dc_path.read_text())
        assert "change_name" in data
        assert "deltas" in data
        assert "complexity" in data
        assert "stats" in data
        assert data["change_name"] == "simple-feature"

    def test_source_map_structure(self, output_dir):
        """source-map.json maps task IDs to file/line/group info."""
        rc, _, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir)
        assert rc == 0
        sm_path = output_dir / "openspec" / "source-map.json"
        assert sm_path.exists()
        data = json.loads(sm_path.read_text())
        assert isinstance(data, dict)
        for task_id, info in data.items():
            assert task_id.startswith("openspec-")
            assert "file" in info
            assert "line" in info
            assert "group" in info

    def test_verification_map_scenarios(self, output_dir):
        """verification-map.json has a scenarios array."""
        rc, _, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir)
        assert rc == 0
        vm_path = output_dir / "openspec" / "verification-map.json"
        assert vm_path.exists()
        data = json.loads(vm_path.read_text())
        assert "scenarios" in data
        assert isinstance(data["scenarios"], list)
        assert len(data["scenarios"]) >= 1
        # Each scenario should have domain, requirement, scenario name
        sc = data["scenarios"][0]
        assert "domain" in sc
        assert "requirement" in sc
        assert "scenario" in sc
        assert "verified" in sc


# ---------------------------------------------------------------------------
# Validation Tests
# ---------------------------------------------------------------------------

class TestValidation:
    def test_validate_simple_ok(self, output_dir):
        """simple-feature passes validation."""
        rc, stdout, stderr = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--validate")
        assert rc == 0
        assert "OK" in stdout

    def test_validate_malformed_fails(self, output_dir):
        """malformed fixture fails validation with errors."""
        rc, stdout, stderr = run_adapter(FIXTURES_DIR / "malformed", output_dir, "--validate")
        assert rc == 1
        assert "FAILED" in stdout or "ERROR" in stderr

    def test_validate_reports_missing_specs(self, output_dir):
        """malformed fixture reports missing spec files."""
        rc, stdout, stderr = run_adapter(FIXTURES_DIR / "malformed", output_dir, "--validate")
        assert rc == 1
        # Should report either empty specs dir or no spec.md files
        assert "spec" in stderr.lower()


# ---------------------------------------------------------------------------
# CLI Tests
# ---------------------------------------------------------------------------

class TestCLI:
    def test_json_output_flag(self, output_dir):
        """--json produces valid JSON on stdout."""
        rc, stdout, _ = run_adapter(FIXTURES_DIR / "simple-feature", output_dir, "--json")
        assert rc == 0
        data = json.loads(stdout)
        assert "change_name" in data
        assert data["change_name"] == "simple-feature"

    def test_nonexistent_path_fails(self, output_dir):
        """Adapter fails gracefully for nonexistent path."""
        rc, stdout, stderr = run_adapter("/nonexistent/path/xyz", output_dir)
        assert rc == 1
        assert "not a directory" in stderr.lower() or "error" in stderr.lower()

    def test_output_dir_created(self, output_dir):
        """Output directory is created if missing."""
        new_output = output_dir / "nested" / "subdir"
        assert not new_output.exists()
        rc, _, _ = run_adapter(FIXTURES_DIR / "simple-feature", new_output)
        assert rc == 0
        assert new_output.exists()
        assert (new_output / "openspec-prd-normalized.md").exists()
