"""Regression tests for the standalone dashboard Docker build context.

These tests materialize only the local files declared by ``dashboard/Dockerfile``
instead of importing from the checkout.  That catches Docker COPY drift even on
hosts where a container daemon is unavailable.
"""

from __future__ import annotations

import glob
import json
import os
from pathlib import Path
import shlex
import shutil
import site
import subprocess
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_ROOT = REPO_ROOT / "dashboard"
DOCKERFILE = DASHBOARD_ROOT / "Dockerfile"
COMPOSE_FILE = DASHBOARD_ROOT / "docker-compose.yml"


def _logical_dockerfile_lines() -> list[str]:
    lines: list[str] = []
    pending = ""
    for raw in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        pending = f"{pending} {stripped}".strip()
        if pending.endswith("\\"):
            pending = pending[:-1].rstrip()
            continue
        lines.append(pending)
        pending = ""
    assert not pending, "Dockerfile ends with an incomplete continuation"
    return lines


def _materialize_declared_package(destination: Path) -> set[str]:
    """Replay runtime Python COPY instructions from the repository context."""

    copied: set[str] = set()

    for line in _logical_dockerfile_lines():
        words = shlex.split(line)
        if not words or words[0].upper() != "COPY" or "--from" in line:
            continue
        target = words[-1]
        if target not in {
            "./dashboard/",
            "./dashboard/static/",
            "./autonomy/lib/",
        }:
            continue
        assert len(words) >= 3, f"invalid COPY instruction: {line}"
        for pattern in words[1:-1]:
            matches = sorted(glob.glob(str(REPO_ROOT / pattern)))
            assert matches, f"COPY source has no match in build context: {pattern}"
            for match_text in matches:
                match = Path(match_text)
                target_dir = destination / target.removeprefix("./")
                target_dir.mkdir(parents=True, exist_ok=True)
                if match.is_file():
                    shutil.copy2(match, target_dir / match.name)
                    copied.add(str((target_dir / match.name).relative_to(destination)))
                    continue
                assert match.is_dir(), f"unsupported COPY source: {match}"
                for source_file in sorted(path for path in match.rglob("*") if path.is_file()):
                    relative = source_file.relative_to(match)
                    target_file = target_dir / relative
                    target_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_file, target_file)
                    copied.add(str(target_file.relative_to(destination)))

    return copied


def _tracked_files(pathspec: str) -> set[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", pathspec],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return {
        path.decode("utf-8")
        for path in result.stdout.split(b"\0")
        if path
    }


def _assert_complete_static_custody(layout: Path) -> None:
    expected = _tracked_files("dashboard/static/**")
    actual = {
        str(path.relative_to(layout))
        for path in (layout / "dashboard" / "static").rglob("*")
        if path.is_file()
    }
    assert expected
    assert "dashboard/static/index.html" in expected
    assert actual == expected


def _import_from_layout(layout: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    dependency_paths = [*site.getsitepackages(), site.getusersitepackages()]
    env.update(
        {
            "HOME": str(layout / "home"),
            "LOKI_DIR": str(layout / "data"),
            "LOKI_DATA_DIR": str(layout / "data"),
            "LOKI_NOTIFICATIONS": "false",
            "LOKI_TELEMETRY_DISABLED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            # HOME is intentionally isolated, so explicitly retain the current
            # interpreter's installed dependencies while excluding the checkout.
            "PYTHONPATH": os.pathsep.join([str(layout), *dependency_paths]),
        }
    )
    return subprocess.run(
        [
            sys.executable,
            "-c",
            "from dashboard.server import app; print(app.title)",
        ],
        cwd=layout,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_declared_layout_has_complete_module_custody_and_imports(tmp_path: Path) -> None:
    copied = _materialize_declared_package(tmp_path)
    tracked_modules = {
        Path(path).name for path in _tracked_files("dashboard/*.py")
    }

    assert tracked_modules
    copied_dashboard_modules = {
        Path(path).name
        for path in copied
        if path.startswith("dashboard/") and path.endswith(".py")
    }
    assert copied_dashboard_modules == tracked_modules
    assert "app_secrets.py" in copied_dashboard_modules
    assert "secrets.py" not in copied_dashboard_modules
    assert "autonomy/lib/deadline.py" in copied
    _assert_complete_static_custody(tmp_path)

    result = _import_from_layout(tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip()


def test_declared_layout_missing_dashboard_module_mutation_is_red(tmp_path: Path) -> None:
    copied = _materialize_declared_package(tmp_path)
    assert "dashboard/app_secrets.py" in copied
    (tmp_path / "dashboard" / "app_secrets.py").unlink()

    result = _import_from_layout(tmp_path)
    assert result.returncode != 0
    assert "app_secrets" in result.stderr


def test_declared_layout_missing_deadline_mutation_is_red(tmp_path: Path) -> None:
    copied = _materialize_declared_package(tmp_path)
    assert "autonomy/lib/deadline.py" in copied
    (tmp_path / "autonomy" / "lib" / "deadline.py").unlink()

    result = _import_from_layout(tmp_path)
    assert result.returncode != 0
    assert "autonomy" in result.stderr


def test_declared_layout_missing_static_mutation_is_red(tmp_path: Path) -> None:
    _materialize_declared_package(tmp_path)
    (tmp_path / "dashboard" / "static" / "index.html").unlink()

    try:
        _assert_complete_static_custody(tmp_path)
    except AssertionError:
        pass
    else:
        raise AssertionError("static custody oracle accepted a missing index")


def test_standalone_command_targets_the_packaged_asgi_app() -> None:
    lines = _logical_dockerfile_lines()
    command_lines = [line for line in lines if line.upper().startswith("CMD ")]
    assert len(command_lines) == 1
    command = json.loads(command_lines[0][len("CMD ") :])
    assert command == [
        "python",
        "-m",
        "uvicorn",
        "dashboard.server:app",
        "--host",
        "0.0.0.0",
        "--port",
        "57374",
    ]

    assert lines.count("USER appuser") == 1
    assert lines.index("USER appuser") < lines.index(command_lines[0])
    assert "ENV HOME=/home/appuser" in lines

    healthchecks = [line for line in lines if line.upper().startswith("HEALTHCHECK ")]
    assert len(healthchecks) == 1
    assert "CMD python -c" in healthchecks[0]
    assert "http://localhost:57374/health" in healthchecks[0]


def test_static_frontend_requirements_and_compose_share_the_root_context() -> None:
    lines = set(_logical_dockerfile_lines())
    assert "COPY dashboard/requirements.txt ./" in lines
    assert "COPY dashboard/static/ ./dashboard/static/" in lines
    assert not any("dashboard/frontend" in line for line in lines)

    compose = COMPOSE_FILE.read_text(encoding="utf-8")
    assert "context: .." in compose
    assert "dockerfile: dashboard/Dockerfile" in compose
