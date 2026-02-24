"""
Rigour Quality Gate Integration for Loki Mode.

Shells out to `npx @rigour-labs/cli` to run quality scans, parses JSON output,
and maps findings to the Loki Mode quality gate format.
"""

import json
import logging
import os
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Compliance presets supported by Rigour CLI
VALID_PRESETS = ("default", "healthcare", "fintech", "government")

# Severity levels in descending order of importance
SEVERITY_LEVELS = ("critical", "major", "minor", "info")

# Grade thresholds
_GRADE_THRESHOLDS = [
    (97, "A+"), (93, "A"), (90, "A-"),
    (87, "B+"), (83, "B"), (80, "B-"),
    (77, "C+"), (73, "C"), (70, "C-"),
    (67, "D+"), (63, "D"), (60, "D-"),
    (0, "F"),
]


def _score_to_grade(score: float) -> str:
    """Convert a numeric score (0-100) to a letter grade."""
    for threshold, grade in _GRADE_THRESHOLDS:
        if score >= threshold:
            return grade
    return "F"


class RigourIntegration:
    """Integration with Rigour Labs CLI for quality scanning."""

    def __init__(self, data_dir: Optional[str] = None) -> None:
        self._data_dir = Path(
            data_dir or os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki"))
        )
        self._scores_dir = self._data_dir / "quality"
        self._scores_file = self._scores_dir / "scores.jsonl"
        self._lock = threading.Lock()
        self._last_score: Optional[dict[str, Any]] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def available(self) -> bool:
        """Check if the Rigour CLI is available via npx."""
        return shutil.which("npx") is not None

    def scan(self, path: str = ".", preset: str = "default") -> dict[str, Any]:
        """Run a Rigour quality scan and return parsed results.

        Args:
            path: Directory or file to scan.
            preset: Compliance preset (default, healthcare, fintech, government).

        Returns:
            Parsed scan results in Loki Mode quality gate format.
        """
        if preset not in VALID_PRESETS:
            return {
                "available": False,
                "error": f"Invalid preset: {preset}. Must be one of {VALID_PRESETS}",
            }

        if not self.available:
            logger.warning("Rigour CLI not available (npx not found). Returning empty results.")
            return self._empty_result(preset, reason="npx not found")

        try:
            result = subprocess.run(
                [
                    "npx", "@rigour-labs/cli", "scan",
                    "--format", "json",
                    "--preset", preset,
                    "--", path,
                ],
                capture_output=True,
                text=True,
                timeout=300,
            )
        except FileNotFoundError:
            logger.warning("npx executable not found at runtime.")
            return self._empty_result(preset, reason="npx not found")
        except subprocess.TimeoutExpired:
            logger.error("Rigour scan timed out after 300s.")
            return self._empty_result(preset, reason="scan timed out")

        if result.returncode != 0 and not result.stdout.strip():
            logger.error("Rigour scan failed (rc=%d): %s", result.returncode, result.stderr.strip())
            return self._empty_result(preset, reason=f"scan failed: {result.stderr.strip()[:200]}")

        try:
            raw = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            logger.error("Failed to parse Rigour JSON output: %s", exc)
            return self._empty_result(preset, reason="invalid JSON output")

        score_data = self._map_to_loki_format(raw, preset)
        self._persist_score(score_data)
        return score_data

    def get_score(self) -> dict[str, Any]:
        """Return the most recent quality score with breakdown.

        If no scan has been run yet, returns the last persisted score or empty.
        """
        with self._lock:
            if self._last_score is not None:
                return self._last_score

        # Try reading the last line of scores.jsonl
        try:
            if self._scores_file.exists():
                lines = self._scores_file.read_text().strip().splitlines()
                if lines:
                    last = json.loads(lines[-1])
                    with self._lock:
                        self._last_score = last
                    return last
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Could not read score history: %s", exc)

        return {
            "available": self.available,
            "score": None,
            "message": "No scan results available. Run a scan first.",
        }

    def get_score_history(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return score trend over time, most recent first.

        Args:
            limit: Maximum number of entries to return.
        """
        entries: list[dict[str, Any]] = []
        try:
            if self._scores_file.exists():
                for line in self._scores_file.read_text().strip().splitlines():
                    if line.strip():
                        try:
                            entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
        except OSError as exc:
            logger.warning("Could not read score history: %s", exc)

        # Most recent first, limited
        entries.reverse()
        return entries[:limit]

    def check_blocking(self, severity: str = "critical") -> bool:
        """Return True if there are blocking issues at or above the given severity.

        Args:
            severity: Minimum severity to consider blocking.
        """
        score = self.get_score()
        if not score or score.get("score") is None:
            return False

        findings = score.get("findings", {})
        try:
            idx = SEVERITY_LEVELS.index(severity.lower())
        except ValueError:
            idx = 0  # Default to critical only

        blocking_severities = SEVERITY_LEVELS[:idx + 1]
        return any(findings.get(s, 0) > 0 for s in blocking_severities)

    def export_report(self, fmt: str = "json") -> str:
        """Generate an audit report from the latest scan.

        Args:
            fmt: Output format (currently only 'json' supported).

        Returns:
            Formatted report string.
        """
        score = self.get_score()
        report = {
            "report_type": "quality_audit",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "format": fmt,
            "available": score.get("available", self.available),
            "current_score": score if score.get("score") is not None else None,
            "history_summary": self._summarize_history(),
            "blocking_issues": self.check_blocking("critical"),
        }

        if fmt == "json":
            return json.dumps(report, indent=2)

        # Plain text fallback
        lines = [
            "Loki Mode Quality Audit Report",
            f"Generated: {report['generated_at']}",
            f"Available: {report['available']}",
            "",
        ]
        if report["current_score"]:
            s = report["current_score"]
            lines.append(f"Score: {s.get('score', 'N/A')} / {s.get('max_score', 100)} ({s.get('grade', 'N/A')})")
            lines.append(f"Preset: {s.get('preset', 'N/A')}")
            findings = s.get("findings", {})
            lines.append(f"Findings: critical={findings.get('critical', 0)} major={findings.get('major', 0)} minor={findings.get('minor', 0)} info={findings.get('info', 0)}")
        else:
            lines.append("No scan data available.")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _map_to_loki_format(self, raw: dict[str, Any], preset: str) -> dict[str, Any]:
        """Map raw Rigour CLI output to Loki Mode quality gate format."""
        # Extract findings by severity
        raw_findings = raw.get("findings", raw.get("issues", []))
        findings: dict[str, int] = {"critical": 0, "major": 0, "minor": 0, "info": 0}
        if isinstance(raw_findings, list):
            for f in raw_findings:
                sev = str(f.get("severity", "info")).lower()
                if sev in findings:
                    findings[sev] += 1
                else:
                    findings["info"] += 1
        elif isinstance(raw_findings, dict):
            for sev in findings:
                findings[sev] = int(_extract_num(raw_findings, sev, 0))

        # Extract category scores
        raw_categories = raw.get("categories", raw.get("scores", {}))
        categories = {
            "security": _extract_num(raw_categories, "security", 0),
            "code_quality": _extract_num(raw_categories, "code_quality", _extract_num(raw_categories, "codeQuality", 0)),
            "compliance": _extract_num(raw_categories, "compliance", 0),
            "best_practices": _extract_num(raw_categories, "best_practices", _extract_num(raw_categories, "bestPractices", 0)),
        }

        # Compute overall score
        raw_score = raw.get("score", raw.get("overall_score"))
        if raw_score is not None:
            try:
                score = float(raw_score)
            except (ValueError, TypeError):
                score = 0.0
        else:
            # Average of non-zero categories
            non_zero = [v for v in categories.values() if v > 0]
            score = round(sum(non_zero) / len(non_zero), 1) if non_zero else 0.0

        result: dict[str, Any] = {
            "available": True,
            "score": round(score, 1),
            "max_score": 100,
            "grade": _score_to_grade(score),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "preset": preset,
            "findings": findings,
            "categories": categories,
        }

        with self._lock:
            self._last_score = result

        return result

    def _persist_score(self, score_data: dict[str, Any]) -> None:
        """Append score to the JSONL history file (thread-safe)."""
        with self._lock:
            try:
                self._scores_dir.mkdir(parents=True, exist_ok=True)
                with open(self._scores_file, "a") as f:
                    f.write(json.dumps(score_data) + "\n")
            except OSError as exc:
                logger.error("Failed to persist score: %s", exc)

    def _empty_result(self, preset: str, reason: str = "") -> dict[str, Any]:
        """Return an empty result when scanning is not possible."""
        return {
            "available": False,
            "score": None,
            "max_score": 100,
            "grade": None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "preset": preset,
            "findings": {"critical": 0, "major": 0, "minor": 0, "info": 0},
            "categories": {"security": 0, "code_quality": 0, "compliance": 0, "best_practices": 0},
            "reason": reason,
        }

    def _summarize_history(self) -> dict[str, Any]:
        """Produce a brief summary of score history."""
        history = self.get_score_history(limit=100)
        if not history:
            return {"entries": 0}

        scores = [h["score"] for h in history if h.get("score") is not None]
        if not scores:
            return {"entries": len(history)}

        return {
            "entries": len(history),
            "latest": scores[0],
            "min": min(scores),
            "max": max(scores),
            "avg": round(sum(scores) / len(scores), 1),
        }


def _extract_num(d: dict, key: str, default: float = 0) -> float:
    """Safely extract a numeric value from a dict."""
    try:
        return float(d.get(key, default))
    except (ValueError, TypeError):
        return default
