#!/usr/bin/env python3
"""MiroFish Market Validation Adapter for Loki Mode

Orchestrates the MiroFish swarm intelligence API to provide pre-build
market validation. Runs MiroFish's 4-stage async pipeline and normalizes
results into Loki Mode's .loki/ directory format.

Stdlib only - no pip dependencies required. Python 3.9+.

Usage:
    python3 mirofish-adapter.py <prd-path> --output-dir .loki/ [--validate] [--json] [--url URL] [--background] [--max-rounds N]
    python3 mirofish-adapter.py --status [--output-dir .loki/]
    python3 mirofish-adapter.py --resume --output-dir .loki/ --url URL
    python3 mirofish-adapter.py --docker-start --docker-image IMAGE [--port N]
    python3 mirofish-adapter.py --docker-stop
    python3 mirofish-adapter.py --health --url URL
"""

import argparse
import json
import os
import re
import sys
import time
import tempfile
import hashlib
import signal
import subprocess
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime, timezone

# Maximum artifact file size (10 MB)
MAX_ARTIFACT_SIZE = 10 * 1024 * 1024

# Container and connection defaults
CONTAINER_NAME = "loki-mirofish"
DEFAULT_URL = "http://localhost:5001"
DEFAULT_PORT = 5001
DEFAULT_MAX_ROUNDS = 100
DEFAULT_TIMEOUT = 3600  # 1 hour total pipeline timeout


# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------

def _safe_read(path: Path) -> str:
    """Read a file with size limit and encoding safety."""
    size = path.stat().st_size
    if size > MAX_ARTIFACT_SIZE:
        raise ValueError(
            f"Artifact too large ({size} bytes, max {MAX_ARTIFACT_SIZE}): {path.name}"
        )
    return path.read_text(encoding="utf-8", errors="replace")


def _write_atomic(path: Path, content: str) -> None:
    """Write content to file atomically using temp file + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, str(path))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _write_json(path: Path, data: Any) -> None:
    """Write JSON data atomically to a file."""
    _write_atomic(path, json.dumps(data, indent=2) + "\n")


def _now_iso() -> str:
    """Return current UTC timestamp in ISO-8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# MiroFish HTTP Client
# ---------------------------------------------------------------------------

class MiroFishClient:
    """HTTP client for the MiroFish swarm intelligence API.

    Uses stdlib urllib only -- no third-party dependencies.
    All methods return parsed JSON dicts. Raises RuntimeError on errors.
    """

    def __init__(self, base_url: str = DEFAULT_URL, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        json_data: Optional[dict] = None,
        form_data: Optional[bytes] = None,
        content_type: Optional[str] = None,
    ) -> dict:
        """Make HTTP request. Returns parsed JSON response.

        Raises RuntimeError on non-2xx status or connection error.
        """
        url = f"{self.base_url}{path}"
        headers: Dict[str, str] = {"Accept": "application/json"}
        body: Optional[bytes] = None

        if json_data is not None:
            body = json.dumps(json_data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif form_data is not None:
            body = form_data
            if content_type:
                headers["Content-Type"] = content_type

        req = urllib.request.Request(url, data=body, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                resp_body = resp.read().decode("utf-8")
                if not resp_body.strip():
                    return {}
                return json.loads(resp_body)
        except urllib.error.HTTPError as exc:
            resp_text = ""
            try:
                resp_text = exc.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            raise RuntimeError(
                f"MiroFish API error: {exc.code} {exc.reason} "
                f"on {method} {path}: {resp_text}"
            ) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(
                f"MiroFish connection error on {method} {path}: {exc.reason}"
            ) from exc
        except Exception as exc:
            raise RuntimeError(
                f"MiroFish request failed on {method} {path}: {exc}"
            ) from exc

    def health_check(self) -> bool:
        """GET /health - returns True if MiroFish is healthy."""
        try:
            resp = self._request("GET", "/health")
            return resp.get("status") == "ok" or bool(resp)
        except RuntimeError:
            return False

    # -- Stage 1: Graph Construction ------------------------------------------

    def generate_ontology(
        self,
        prd_path: str,
        simulation_requirement: str,
        project_name: str = "",
    ) -> dict:
        """POST /api/graph/ontology/generate - multipart/form-data upload.

        Uploads the PRD file and simulation_requirement text.
        Returns: {project_id, ontology: {entity_types, edge_types, analysis_summary}}
        """
        import secrets
        boundary = secrets.token_hex(16)

        parts: List[bytes] = []

        # File field (enforce size limit before reading)
        prd_file = Path(prd_path)
        file_size = prd_file.stat().st_size
        if file_size > MAX_ARTIFACT_SIZE:
            raise ValueError(
                f"PRD too large ({file_size} bytes, max {MAX_ARTIFACT_SIZE}): {prd_file.name}"
            )
        filename = prd_file.name
        file_content = prd_file.read_bytes()
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="prd_file"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode("utf-8")
            + file_content
            + b"\r\n"
        )

        # Text fields
        for field_name, field_value in [
            ("simulation_requirement", simulation_requirement),
            ("project_name", project_name),
        ]:
            parts.append(
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{field_name}"\r\n\r\n'
                f"{field_value}\r\n".encode("utf-8")
            )

        parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        form_body = b"".join(parts)
        ct = f"multipart/form-data; boundary={boundary}"

        return self._request(
            "POST",
            "/api/graph/ontology/generate",
            form_data=form_body,
            content_type=ct,
        )

    def build_graph(self, project_id: str) -> dict:
        """POST /api/graph/build - start async graph building.

        Returns: {project_id, graph_id, task_id, status}
        """
        return self._request(
            "POST", "/api/graph/build", json_data={"project_id": project_id}
        )

    def poll_graph_build(
        self, task_id: str, max_wait: int = 600, interval: int = 5
    ) -> dict:
        """POST /api/graph/build/status - poll until completed or timeout.

        Returns final status dict with graph_id.
        """
        deadline = time.time() + max_wait
        while time.time() < deadline:
            resp = self._request(
                "POST",
                "/api/graph/build/status",
                json_data={"task_id": task_id},
            )
            data = resp.get("data", resp)
            status = data.get("status", "")
            if status == "completed":
                return data
            if status in ("failed", "error"):
                raise RuntimeError(
                    f"Graph build failed: {data.get('error', 'unknown')}"
                )
            time.sleep(interval)
        raise RuntimeError(
            f"Graph build timed out after {max_wait}s (task_id={task_id})"
        )

    # -- Stage 2: Simulation Setup --------------------------------------------

    def create_simulation(
        self,
        project_id: str,
        graph_id: str,
        enable_twitter: bool = True,
        enable_reddit: bool = True,
    ) -> dict:
        """POST /api/simulation/create

        Returns: {simulation_id, status}
        """
        return self._request(
            "POST",
            "/api/simulation/create",
            json_data={
                "project_id": project_id,
                "graph_id": graph_id,
                "enable_twitter": enable_twitter,
                "enable_reddit": enable_reddit,
            },
        )

    def prepare_simulation(self, simulation_id: str) -> dict:
        """POST /api/simulation/prepare - async profile generation.

        Returns: {simulation_id, task_id, status, expected_entities_count}
        """
        return self._request(
            "POST",
            "/api/simulation/prepare",
            json_data={"simulation_id": simulation_id},
        )

    def poll_prepare(
        self, task_id: str, max_wait: int = 900, interval: int = 10
    ) -> dict:
        """POST /api/simulation/prepare/status - poll until ready."""
        deadline = time.time() + max_wait
        while time.time() < deadline:
            resp = self._request(
                "POST",
                "/api/simulation/prepare/status",
                json_data={"task_id": task_id},
            )
            data = resp.get("data", resp)
            status = data.get("status", "")
            if status == "completed":
                return data
            if status in ("failed", "error"):
                raise RuntimeError(
                    f"Simulation prepare failed: {data.get('error', 'unknown')}"
                )
            time.sleep(interval)
        raise RuntimeError(
            f"Simulation prepare timed out after {max_wait}s (task_id={task_id})"
        )

    # -- Stage 3: Simulation Execution ----------------------------------------

    def start_simulation(
        self,
        simulation_id: str,
        platform: str = "parallel",
        max_rounds: int = 100,
    ) -> dict:
        """POST /api/simulation/start

        Returns: {simulation_id, runner_status, process_pid}
        """
        return self._request(
            "POST",
            "/api/simulation/start",
            json_data={
                "simulation_id": simulation_id,
                "platform": platform,
                "max_rounds": max_rounds,
            },
        )

    def poll_run_status(
        self, simulation_id: str, max_wait: int = 1800, interval: int = 15
    ) -> dict:
        """GET /api/simulation/{simulation_id}/run-status - poll until completed.

        Returns: {runner_status, current_round, total_rounds, progress}
        """
        deadline = time.time() + max_wait
        while time.time() < deadline:
            resp = self._request(
                "GET", f"/api/simulation/{simulation_id}/run-status"
            )
            data = resp.get("data", resp)
            status = data.get("runner_status", "")
            if status == "completed":
                return data
            if status in ("failed", "error", "stopped"):
                raise RuntimeError(
                    f"Simulation run failed: status={status}, "
                    f"detail={data.get('error', 'unknown')}"
                )
            time.sleep(interval)
        raise RuntimeError(
            f"Simulation run timed out after {max_wait}s "
            f"(simulation_id={simulation_id})"
        )

    def stop_simulation(self, simulation_id: str) -> dict:
        """POST /api/simulation/stop"""
        return self._request(
            "POST",
            "/api/simulation/stop",
            json_data={"simulation_id": simulation_id},
        )

    # -- Stage 4: Report ------------------------------------------------------

    def generate_report(self, simulation_id: str) -> dict:
        """POST /api/report/generate - async report generation.

        Returns: {report_id, task_id, status}
        """
        return self._request(
            "POST",
            "/api/report/generate",
            json_data={"simulation_id": simulation_id},
        )

    def poll_report(
        self, task_id: str, max_wait: int = 600, interval: int = 5
    ) -> dict:
        """POST /api/report/generate/status - poll until completed."""
        deadline = time.time() + max_wait
        while time.time() < deadline:
            resp = self._request(
                "POST",
                "/api/report/generate/status",
                json_data={"task_id": task_id},
            )
            data = resp.get("data", resp)
            status = data.get("status", "")
            if status == "completed":
                return data
            if status in ("failed", "error"):
                raise RuntimeError(
                    f"Report generation failed: {data.get('error', 'unknown')}"
                )
            time.sleep(interval)
        raise RuntimeError(
            f"Report generation timed out after {max_wait}s (task_id={task_id})"
        )

    def get_report(self, report_id: str) -> dict:
        """GET /api/report/{report_id}

        Returns: {report_id, simulation_id, status, sections: [{index, title, content}]}
        """
        return self._request("GET", f"/api/report/{report_id}")


# ---------------------------------------------------------------------------
# PRD Translation
# ---------------------------------------------------------------------------

def extract_simulation_context(prd_path: Path) -> dict:
    """Parse PRD markdown to extract simulation seed material.

    Looks for (case-insensitive):
    - Project name: from first H1 heading, or filename
    - Simulation requirement: from ## Problem Statement, ## Value Proposition,
      ## Overview, ## Summary sections
    - Target audience: from ## Target Audience, ## Users, ## User Personas sections

    Fallback: first 2000 chars of PRD as simulation_requirement.

    Returns: {
        "project_name": str,
        "simulation_requirement": str,
        "target_audience": str,
        "prd_summary": str
    }
    """
    text = _safe_read(prd_path)

    result: Dict[str, str] = {
        "project_name": "",
        "simulation_requirement": "",
        "target_audience": "",
        "prd_summary": "",
    }

    # Extract project name from first H1 heading
    h1_match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if h1_match:
        result["project_name"] = h1_match.group(1).strip()
    else:
        # Fallback to filename without extension
        result["project_name"] = prd_path.stem.replace("-", " ").replace("_", " ").title()

    # Split into sections by ## headings
    sections = _split_sections(text)

    # Keywords for simulation requirement (priority order)
    req_keywords = [
        "problem statement",
        "value proposition",
        "overview",
        "summary",
    ]

    # Keywords for target audience
    audience_keywords = [
        "target audience",
        "users",
        "user personas",
    ]

    for heading, body in sections.items():
        heading_lower = heading.lower().strip()
        # Check for simulation requirement sections
        if not result["simulation_requirement"]:
            for kw in req_keywords:
                if kw in heading_lower:
                    result["simulation_requirement"] = body.strip()
                    break
        # Check for target audience sections
        if not result["target_audience"]:
            for kw in audience_keywords:
                if kw in heading_lower:
                    result["target_audience"] = body.strip()
                    break

    # Fallback: use first 2000 chars of PRD as simulation_requirement
    if not result["simulation_requirement"]:
        result["simulation_requirement"] = text[:2000].strip()

    # PRD summary: first 200 chars for logging
    result["prd_summary"] = text[:200].strip()

    return result


def _split_sections(text: str, level: int = 2) -> Dict[str, str]:
    """Split markdown text into sections by heading level.

    Returns {heading_text: body_text} preserving order.
    """
    prefix = "#" * level
    pattern = re.compile(rf"^{prefix}\s+(.+)$", re.MULTILINE)
    matches = list(pattern.finditer(text))
    sections: Dict[str, str] = {}
    for i, m in enumerate(matches):
        heading = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[heading] = text[start:end].strip()
    return sections


# ---------------------------------------------------------------------------
# Pipeline State Management
# ---------------------------------------------------------------------------

def _update_pipeline_state(output_dir: Path, state: dict) -> None:
    """Write pipeline-state.json atomically."""
    state["updated_at"] = _now_iso()
    state_path = output_dir / "mirofish" / "pipeline-state.json"
    _write_json(state_path, state)


def _load_pipeline_state(output_dir: Path) -> Optional[dict]:
    """Load existing pipeline state, or None."""
    state_path = output_dir / "mirofish" / "pipeline-state.json"
    if not state_path.exists():
        return None
    try:
        text = _safe_read(state_path)
        return json.loads(text)
    except (json.JSONDecodeError, ValueError, OSError):
        return None


# ---------------------------------------------------------------------------
# Report Normalization
# ---------------------------------------------------------------------------

# Sentiment keyword sets for simple heuristic analysis
_POSITIVE_KEYWORDS = [
    "positive", "strong", "adoption", "interest", "favorable",
    "loved", "benefit", "opportunity", "success", "growth",
    "promising", "enthusiastic", "excited", "valuable",
]
_NEGATIVE_KEYWORDS = [
    "concern", "risk", "negative", "reluctance", "resistance",
    "problem", "issue", "challenge", "difficult", "unfavorable",
    "reject", "opposed", "cautious", "wary", "worried",
]


def normalize_report(
    report_data: dict, simulation_data: Optional[dict] = None
) -> dict:
    """Convert MiroFish report into Loki Mode advisory format.

    Analyzes report sections to extract:
    - overall_sentiment: positive/negative/mixed
    - confidence: low/medium/high
    - sentiment_score: 0.0-1.0 (keyword-based heuristic)
    - key_concerns: list of risk/concern strings
    - feature_rankings: list of {feature, reception_score}
    - notable_quotes: interesting agent reactions (max 5)
    - recommendation: proceed/review_concerns/reconsider

    The sentiment analysis uses simple keyword matching since we cannot
    import NLP libraries.

    Returns the full mirofish-context.json structure.
    """
    data = report_data.get("data", report_data)
    sections = data.get("sections", [])

    # Combine all section content for keyword analysis
    all_content = " ".join(s.get("content", "") for s in sections).lower()

    # --- Sentiment score (keyword heuristic) ---
    pos_count = sum(1 for kw in _POSITIVE_KEYWORDS if kw in all_content)
    neg_count = sum(1 for kw in _NEGATIVE_KEYWORDS if kw in all_content)
    total_kw = pos_count + neg_count
    if total_kw > 0:
        sentiment_score = round(pos_count / total_kw, 2)
    else:
        sentiment_score = 0.5  # neutral default

    # Overall sentiment classification
    if sentiment_score >= 0.65:
        overall_sentiment = "positive"
    elif sentiment_score <= 0.35:
        overall_sentiment = "negative"
    else:
        overall_sentiment = "mixed"

    # --- Confidence level ---
    # Based on available data richness
    section_count = len(sections)
    entity_count = 0
    round_count = 0
    if simulation_data:
        sim_inner = simulation_data.get("data", simulation_data)
        entity_count = sim_inner.get("expected_entities_count", 0)
        round_count = sim_inner.get("total_rounds", 0)

    if section_count >= 5 and (entity_count >= 50 or round_count >= 80):
        confidence = "high"
    elif section_count >= 3:
        confidence = "medium"
    else:
        confidence = "low"

    # --- Key concerns ---
    key_concerns: List[str] = []
    for section in sections:
        title = section.get("title", "").lower()
        content = section.get("content", "")
        if "concern" in title or "risk" in title:
            # Extract numbered items
            for m in re.finditer(
                r"\d+\.\s+([^.]+?)(?::\s*(.+?))?(?=\d+\.\s|\Z)",
                content,
                re.DOTALL,
            ):
                concern = m.group(1).strip()
                if concern:
                    key_concerns.append(concern)

    # --- Feature rankings ---
    feature_rankings: List[Dict[str, Any]] = []
    for section in sections:
        title = section.get("title", "").lower()
        content = section.get("content", "")
        if "feature" in title or "ranking" in title or "reception" in title:
            # Extract lines like: N. Feature name (reception: 0.XX)
            for m in re.finditer(
                r"\d+\.\s+(.+?)\s*\(reception:\s*([\d.]+)\)",
                content,
            ):
                feature_rankings.append({
                    "feature": m.group(1).strip(),
                    "reception_score": float(m.group(2)),
                })

    # --- Notable quotes ---
    notable_quotes: List[str] = []
    for section in sections:
        title = section.get("title", "").lower()
        content = section.get("content", "")
        if "notable" in title or "reaction" in title or "quote" in title:
            for m in re.finditer(r"'([^']{10,})'", content):
                notable_quotes.append(m.group(1).strip())
                if len(notable_quotes) >= 5:
                    break
        if len(notable_quotes) >= 5:
            break

    # --- Recommendation ---
    if sentiment_score >= 0.65 and len(key_concerns) <= 2:
        recommendation = "proceed"
    elif sentiment_score <= 0.35:
        recommendation = "reconsider"
    else:
        recommendation = "review_concerns"

    return {
        "source": "mirofish",
        "version": "1.0",
        "generated_at": _now_iso(),
        "report_id": data.get("report_id", ""),
        "simulation_id": data.get("simulation_id", ""),
        "analysis": {
            "overall_sentiment": overall_sentiment,
            "sentiment_score": sentiment_score,
            "confidence": confidence,
            "recommendation": recommendation,
            "key_concerns": key_concerns,
            "feature_rankings": feature_rankings,
            "notable_quotes": notable_quotes,
        },
        "section_count": section_count,
        "raw_sections": [
            {"title": s.get("title", ""), "index": s.get("index", i)}
            for i, s in enumerate(sections)
        ],
    }


def build_mirofish_tasks(report_data: dict) -> list:
    """Extract actionable items from report sections.

    Looks for:
    - Sections with "risk" or "concern" in title -> high priority tasks
    - Sections with "recommendation" in title -> medium priority tasks
    - Bullet points starting with "Should", "Must", "Consider" -> tasks

    Returns list of {id, title, description, priority, source, category}.
    """
    data = report_data.get("data", report_data)
    sections = data.get("sections", [])
    tasks: List[Dict[str, Any]] = []
    task_counter = 0

    for section in sections:
        title = section.get("title", "").lower()
        content = section.get("content", "")

        # Determine priority and category based on section title
        if "risk" in title or "concern" in title:
            priority = "high"
            category = "risk_mitigation"
        elif "recommendation" in title:
            priority = "medium"
            category = "recommendation"
        else:
            # Scan content for actionable keywords even in other sections
            priority = "low"
            category = "insight"

        # Extract sentences starting with action keywords
        for m in re.finditer(
            r"(?:^|(?<=\.\s)|(?<=\d\.\s))"
            r"((?:Should|Must|Consider|Recommendation:)\s+[^.]+\.?)",
            content,
            re.MULTILINE,
        ):
            task_counter += 1
            task_text = m.group(1).strip().rstrip(".")
            tasks.append({
                "id": f"mirofish-{task_counter:03d}",
                "title": task_text[:120],
                "description": task_text,
                "priority": priority,
                "source": "mirofish",
                "category": category,
            })

    return tasks


# ---------------------------------------------------------------------------
# Pipeline Summary Generation
# ---------------------------------------------------------------------------

def _build_summary_markdown(context: dict, tasks: list) -> str:
    """Build a human-readable summary markdown from normalized data."""
    lines: List[str] = []
    analysis = context.get("analysis", {})

    lines.append("# MiroFish Market Validation Summary")
    lines.append("")
    lines.append(f"Generated: {context.get('generated_at', 'unknown')}")
    lines.append(f"Report ID: {context.get('report_id', 'unknown')}")
    lines.append(f"Simulation ID: {context.get('simulation_id', 'unknown')}")
    lines.append("")

    lines.append("## Overall Assessment")
    lines.append("")
    lines.append(f"- Sentiment: {analysis.get('overall_sentiment', 'unknown')}")
    lines.append(f"- Sentiment Score: {analysis.get('sentiment_score', 'N/A')}")
    lines.append(f"- Confidence: {analysis.get('confidence', 'unknown')}")
    lines.append(f"- Recommendation: {analysis.get('recommendation', 'unknown')}")
    lines.append("")

    concerns = analysis.get("key_concerns", [])
    if concerns:
        lines.append("## Key Concerns")
        lines.append("")
        for concern in concerns:
            lines.append(f"- {concern}")
        lines.append("")

    rankings = analysis.get("feature_rankings", [])
    if rankings:
        lines.append("## Feature Rankings")
        lines.append("")
        for rank in rankings:
            lines.append(
                f"- {rank.get('feature', 'unknown')}: "
                f"{rank.get('reception_score', 'N/A')}"
            )
        lines.append("")

    quotes = analysis.get("notable_quotes", [])
    if quotes:
        lines.append("## Notable Agent Reactions")
        lines.append("")
        for quote in quotes:
            lines.append(f"> {quote}")
            lines.append("")

    if tasks:
        lines.append("## Action Items")
        lines.append("")
        for task in tasks:
            prio = task.get("priority", "medium")
            lines.append(f"- [{prio.upper()}] {task.get('title', '')}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Pipeline Orchestration
# ---------------------------------------------------------------------------

def run_pipeline(
    client: MiroFishClient,
    prd_path: Path,
    output_dir: Path,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
    timeout: int = DEFAULT_TIMEOUT,
) -> int:
    """Execute the 4-stage MiroFish pipeline.

    Stage 1: Generate ontology from PRD (upload file + requirement)
    Stage 2: Build knowledge graph (async, poll)
    Stage 3: Create + prepare + run simulation (async, poll)
    Stage 4: Generate + retrieve report (async, poll)

    After each stage:
    - Write stage output to output_dir/mirofish/
    - Update pipeline-state.json

    On completion:
    - Write mirofish-context.json (normalized advisory)
    - Write mirofish-tasks.json (queue-ready tasks)
    - Write mirofish-summary.md (human-readable)

    Returns 0 on success, 1 on failure.
    """
    mf_dir = output_dir / "mirofish"
    mf_dir.mkdir(parents=True, exist_ok=True)

    # Pipeline deadline for timeout enforcement
    pipeline_deadline = time.monotonic() + timeout

    # Compute PRD hash for caching / dedup
    prd_content = _safe_read(prd_path)
    prd_hash = hashlib.sha256(prd_content.encode("utf-8")).hexdigest()[:16]

    # Initialize pipeline state
    state: Dict[str, Any] = {
        "version": "1.0",
        "prd_path": str(prd_path.resolve()),
        "prd_hash": prd_hash,
        "base_url": client.base_url,
        "started_at": _now_iso(),
        "updated_at": _now_iso(),
        "status": "running",
        "current_stage": 1,
        "pid": os.getpid(),
        "stages": {
            "1_ontology": {"status": "pending"},
            "2_graph": {"status": "pending"},
            "3_simulation": {"status": "pending"},
            "4_report": {"status": "pending"},
        },
        "error": None,
    }
    _update_pipeline_state(output_dir, state)

    def _check_deadline(stage_label: str) -> None:
        """Raise TimeoutError if pipeline has exceeded its timeout."""
        if time.monotonic() > pipeline_deadline:
            raise TimeoutError(
                f"Pipeline timeout ({timeout}s) exceeded before {stage_label}"
            )

    try:
        # Extract simulation context from PRD
        context = extract_simulation_context(prd_path)
        print(
            f"MiroFish: project={context['project_name']!r} "
            f"prd_hash={prd_hash}"
        )

        # -- Stage 1: Ontology ------------------------------------------------
        _check_deadline("Stage 1: Ontology")
        print("MiroFish Stage 1/4: Generating ontology...")
        onto_resp = client.generate_ontology(
            prd_path=str(prd_path),
            simulation_requirement=context["simulation_requirement"],
            project_name=context["project_name"],
        )
        onto_data = onto_resp.get("data", onto_resp)
        project_id = onto_data["project_id"]

        state["stages"]["1_ontology"] = {
            "status": "completed",
            "project_id": project_id,
            "completed_at": _now_iso(),
        }
        state["current_stage"] = 2
        _update_pipeline_state(output_dir, state)
        _write_json(mf_dir / "ontology.json", onto_resp)
        print(f"MiroFish Stage 1/4: Ontology complete (project={project_id})")

        # -- Stage 2: Graph Build ---------------------------------------------
        _check_deadline("Stage 2: Graph Build")
        print("MiroFish Stage 2/4: Building knowledge graph...")
        build_resp = client.build_graph(project_id)
        build_data = build_resp.get("data", build_resp)
        task_id = build_data["task_id"]

        state["stages"]["2_graph"]["status"] = "running"
        state["stages"]["2_graph"]["task_id"] = task_id
        _update_pipeline_state(output_dir, state)

        graph_result = client.poll_graph_build(task_id)
        graph_id = graph_result.get("graph_id", "")

        state["stages"]["2_graph"] = {
            "status": "completed",
            "graph_id": graph_id,
            "completed_at": _now_iso(),
        }
        state["current_stage"] = 3
        _update_pipeline_state(output_dir, state)
        _write_json(mf_dir / "graph.json", graph_result)
        print(f"MiroFish Stage 2/4: Graph complete (graph_id={graph_id})")

        # -- Stage 3: Simulation ----------------------------------------------
        _check_deadline("Stage 3: Simulation")
        print("MiroFish Stage 3/4: Running simulation...")

        # Create simulation
        sim_resp = client.create_simulation(project_id, graph_id)
        sim_data = sim_resp.get("data", sim_resp)
        simulation_id = sim_data["simulation_id"]

        state["stages"]["3_simulation"]["status"] = "running"
        state["stages"]["3_simulation"]["simulation_id"] = simulation_id
        _update_pipeline_state(output_dir, state)

        # Prepare simulation (async profile generation)
        prep_resp = client.prepare_simulation(simulation_id)
        prep_data = prep_resp.get("data", prep_resp)
        prep_task_id = prep_data["task_id"]

        prep_result = client.poll_prepare(prep_task_id)

        # Start simulation run
        start_resp = client.start_simulation(
            simulation_id, max_rounds=max_rounds
        )
        _write_json(mf_dir / "simulation-start.json", start_resp)

        # Poll until simulation completes
        sim_result = client.poll_run_status(simulation_id)

        state["stages"]["3_simulation"] = {
            "status": "completed",
            "simulation_id": simulation_id,
            "completed_at": _now_iso(),
        }
        state["current_stage"] = 4
        _update_pipeline_state(output_dir, state)
        _write_json(mf_dir / "simulation-result.json", sim_result)
        print(
            f"MiroFish Stage 3/4: Simulation complete "
            f"(simulation_id={simulation_id})"
        )

        # -- Stage 4: Report --------------------------------------------------
        _check_deadline("Stage 4: Report")
        print("MiroFish Stage 4/4: Generating report...")
        report_resp = client.generate_report(simulation_id)
        report_data = report_resp.get("data", report_resp)
        report_task_id = report_data["task_id"]

        state["stages"]["4_report"]["status"] = "running"
        state["stages"]["4_report"]["task_id"] = report_task_id
        _update_pipeline_state(output_dir, state)

        report_result = client.poll_report(report_task_id)
        report_id = report_result.get("report_id", "")

        # Fetch full report
        full_report = client.get_report(report_id)
        _write_json(mf_dir / "report.json", full_report)

        state["stages"]["4_report"] = {
            "status": "completed",
            "report_id": report_id,
            "completed_at": _now_iso(),
        }
        _update_pipeline_state(output_dir, state)
        print(f"MiroFish Stage 4/4: Report complete (report_id={report_id})")

        # -- Normalize and write final outputs --------------------------------
        normalized = normalize_report(full_report, simulation_data=prep_result)
        tasks = build_mirofish_tasks(full_report)
        summary_md = _build_summary_markdown(normalized, tasks)

        _write_json(output_dir / "mirofish-context.json", normalized)
        _write_json(output_dir / "mirofish-tasks.json", tasks)
        _write_atomic(output_dir / "mirofish-summary.md", summary_md)

        # Mark pipeline complete
        state["status"] = "completed"
        state["completed_at"] = _now_iso()
        _update_pipeline_state(output_dir, state)

        print(
            f"MiroFish: Pipeline complete. "
            f"Sentiment={normalized['analysis']['overall_sentiment']} "
            f"Recommendation={normalized['analysis']['recommendation']} "
            f"Tasks={len(tasks)}"
        )
        return 0

    except TimeoutError as exc:
        state["status"] = "failed"
        state["error"] = str(exc)
        _update_pipeline_state(output_dir, state)
        print(f"ERROR: MiroFish pipeline timed out: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        state["status"] = "failed"
        state["error"] = str(exc)
        _update_pipeline_state(output_dir, state)
        print(f"ERROR: MiroFish pipeline failed: {exc}", file=sys.stderr)
        return 1
    except KeyError as exc:
        state["status"] = "failed"
        state["error"] = f"Missing key in API response: {exc}"
        _update_pipeline_state(output_dir, state)
        print(
            f"ERROR: MiroFish pipeline failed (missing key): {exc}",
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        state["status"] = "failed"
        state["error"] = str(exc)
        _update_pipeline_state(output_dir, state)
        print(
            f"ERROR: MiroFish pipeline failed unexpectedly: {exc}",
            file=sys.stderr,
        )
        return 1


def run_background(
    prd_path: str,
    output_dir: str,
    base_url: str,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
    timeout: int = DEFAULT_TIMEOUT,
) -> int:
    """Run pipeline in a background process. Parent returns 0 immediately.

    On POSIX: uses os.fork() + setsid to detach from terminal.
    On Windows: uses subprocess.Popen with CREATE_NEW_PROCESS_GROUP.

    Child/subprocess:
    1. Redirects stdout/stderr to output_dir/mirofish/pipeline.log
    2. Writes PID to pipeline-state.json
    3. Runs run_pipeline()
    4. Updates state to completed/failed
    """
    # Ensure output directory exists before spawning
    mf_dir = Path(output_dir) / "mirofish"
    mf_dir.mkdir(parents=True, exist_ok=True)

    if sys.platform == "win32":
        # Windows: cannot fork; use subprocess with CREATE_NEW_PROCESS_GROUP
        import subprocess as _sp
        log_path = mf_dir / "pipeline.log"
        cmd = [
            sys.executable, __file__,
            prd_path,
            "--output-dir", output_dir,
            "--url", base_url,
            "--max-rounds", str(max_rounds),
            "--timeout", str(timeout),
        ]
        log_fh = open(str(log_path), "w", encoding="utf-8")
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        proc = _sp.Popen(
            cmd,
            stdout=log_fh,
            stderr=log_fh,
            stdin=_sp.DEVNULL,
            creationflags=CREATE_NEW_PROCESS_GROUP,
        )
        print(f"MiroFish: Background pipeline started (pid={proc.pid})")
        return 0

    # POSIX: fork + setsid
    pid = os.fork()
    if pid > 0:
        # Parent process
        print(f"MiroFish: Background pipeline started (pid={pid})")
        return 0

    # Child process
    try:
        os.setsid()

        # Redirect stdout/stderr to log file
        log_path = mf_dir / "pipeline.log"
        log_fd = os.open(
            str(log_path),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o644,
        )
        os.dup2(log_fd, 1)  # stdout
        os.dup2(log_fd, 2)  # stderr
        os.close(log_fd)

        # Close stdin
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)

        # Set up signal handler so graceful termination updates state
        def _handle_term(signum: int, frame: Any) -> None:
            state = _load_pipeline_state(Path(output_dir))
            if state:
                state["status"] = "cancelled"
                state["updated_at"] = _now_iso()
                state["error"] = f"Cancelled by signal {signum}"
                _update_pipeline_state(Path(output_dir), state)
            os._exit(130)

        signal.signal(signal.SIGTERM, _handle_term)
        signal.signal(signal.SIGINT, _handle_term)

        client = MiroFishClient(base_url=base_url)
        exit_code = run_pipeline(
            client=client,
            prd_path=Path(prd_path),
            output_dir=Path(output_dir),
            max_rounds=max_rounds,
            timeout=timeout,
        )
        os._exit(exit_code)  # noqa: use _exit in forked child
    except Exception:
        os._exit(1)


# ---------------------------------------------------------------------------
# Docker Management
# ---------------------------------------------------------------------------

def _run_docker(
    args: List[str], check: bool = False, capture: bool = True
) -> subprocess.CompletedProcess:
    """Run docker command, return CompletedProcess."""
    cmd = ["docker"] + args
    return subprocess.run(
        cmd,
        capture_output=capture,
        text=True,
        timeout=120,
        check=check,
    )


def check_container() -> str:
    """Check MiroFish container status.

    Returns: 'running', 'stopped', or 'not_found'.
    """
    result = _run_docker(
        ["inspect", "--format", "{{.State.Status}}", CONTAINER_NAME]
    )
    if result.returncode != 0:
        return "not_found"
    status = result.stdout.strip().lower()
    if status == "running":
        return "running"
    return "stopped"


def start_container(
    image: str,
    port: int = DEFAULT_PORT,
    env_vars: Optional[Dict[str, str]] = None,
) -> bool:
    """Start MiroFish Docker container. Check-before-create pattern.

    1. If running: return True (already running)
    2. If stopped: docker start loki-mirofish
    3. If not_found: docker run -d --name loki-mirofish
           -p {port}:5001 -e LLM_API_KEY -e ZEP_API_KEY {image}
    4. Wait for healthy (poll /health, max 60s)

    Passes LLM_API_KEY and ZEP_API_KEY from os.environ if present.
    """
    status = check_container()

    if status == "running":
        print(f"MiroFish: Container {CONTAINER_NAME} already running")
        return True

    if status == "stopped":
        print(f"MiroFish: Starting stopped container {CONTAINER_NAME}")
        result = _run_docker(["start", CONTAINER_NAME])
        if result.returncode != 0:
            print(
                f"ERROR: Failed to start container: {result.stderr}",
                file=sys.stderr,
            )
            return False
    else:
        # not_found -- create new container
        print(f"MiroFish: Creating container {CONTAINER_NAME} from {image}")
        cmd = [
            "run", "-d",
            "--name", CONTAINER_NAME,
            "-p", f"{port}:5001",
        ]

        # Pass through environment variables
        all_env = dict(env_vars or {})
        for key in ("LLM_API_KEY", "ZEP_API_KEY"):
            val = os.environ.get(key)
            if val:
                all_env[key] = val
        for key, val in all_env.items():
            cmd.extend(["-e", f"{key}={val}"])

        cmd.append(image)
        result = _run_docker(cmd)
        if result.returncode != 0:
            print(
                f"ERROR: Failed to create container: {result.stderr}",
                file=sys.stderr,
            )
            return False

    # Wait for healthy
    base_url = f"http://localhost:{port}"
    if wait_for_healthy(base_url):
        print(f"MiroFish: Container healthy at {base_url}")
        return True
    else:
        print(
            f"ERROR: Container started but health check failed at {base_url}",
            file=sys.stderr,
        )
        return False


def stop_container() -> bool:
    """Stop MiroFish container gracefully.

    docker stop loki-mirofish --time 10, then docker rm if needed.
    """
    status = check_container()
    if status == "not_found":
        print(f"MiroFish: Container {CONTAINER_NAME} not found")
        return True

    if status == "running":
        print(f"MiroFish: Stopping container {CONTAINER_NAME}")
        result = _run_docker(["stop", "--time", "10", CONTAINER_NAME])
        if result.returncode != 0:
            print(
                f"ERROR: Failed to stop container: {result.stderr}",
                file=sys.stderr,
            )
            return False

    # Remove stopped container
    result = _run_docker(["rm", CONTAINER_NAME])
    if result.returncode != 0:
        print(
            f"WARNING: Failed to remove container: {result.stderr}",
            file=sys.stderr,
        )
        # Not a fatal error -- container is stopped
    else:
        print(f"MiroFish: Container {CONTAINER_NAME} removed")

    return True


def wait_for_healthy(base_url: str, max_wait: int = 60) -> bool:
    """Poll GET {base_url}/health every 2s until ok or timeout."""
    client = MiroFishClient(base_url=base_url, timeout=5)
    deadline = time.time() + max_wait
    while time.time() < deadline:
        if client.health_check():
            return True
        time.sleep(2)
    return False


# ---------------------------------------------------------------------------
# CLI Entry Points
# ---------------------------------------------------------------------------

def validate_prd(prd_path: Path, base_url: str = DEFAULT_URL) -> int:
    """Validate PRD can be parsed for MiroFish. Returns 0 if valid."""
    if not prd_path.exists():
        print(f"ERROR: PRD file not found: {prd_path}", file=sys.stderr)
        return 1

    if prd_path.stat().st_size == 0:
        print(f"ERROR: PRD file is empty: {prd_path}", file=sys.stderr)
        return 1

    try:
        context = extract_simulation_context(prd_path)
    except Exception as exc:
        print(f"ERROR: Failed to parse PRD: {exc}", file=sys.stderr)
        return 1

    if not context.get("simulation_requirement"):
        print(
            "ERROR: Could not extract simulation requirement from PRD",
            file=sys.stderr,
        )
        return 1

    print(
        f"MiroFish PRD validation: OK\n"
        f"  Project: {context['project_name']}\n"
        f"  Requirement length: {len(context['simulation_requirement'])} chars\n"
        f"  Target audience: {'found' if context.get('target_audience') else 'not found'}"
    )
    return 0


def show_status(output_dir: Path) -> int:
    """Show pipeline status from pipeline-state.json."""
    state = _load_pipeline_state(output_dir)
    if state is None:
        print("MiroFish: No pipeline state found. No pipeline has been run.")
        return 0

    print(f"MiroFish Pipeline Status")
    print(f"  Status: {state.get('status', 'unknown')}")
    print(f"  Started: {state.get('started_at', 'unknown')}")
    print(f"  Updated: {state.get('updated_at', 'unknown')}")
    print(f"  Current stage: {state.get('current_stage', 'unknown')}")
    print(f"  PRD: {state.get('prd_path', 'unknown')}")

    if state.get("completed_at"):
        print(f"  Completed: {state['completed_at']}")

    if state.get("error"):
        print(f"  Error: {state['error']}")

    stages = state.get("stages", {})
    for stage_name, stage_data in sorted(stages.items()):
        stage_status = stage_data.get("status", "unknown")
        extra = ""
        if stage_data.get("project_id"):
            extra = f" (project={stage_data['project_id']})"
        elif stage_data.get("graph_id"):
            extra = f" (graph={stage_data['graph_id']})"
        elif stage_data.get("simulation_id"):
            extra = f" (simulation={stage_data['simulation_id']})"
        elif stage_data.get("report_id"):
            extra = f" (report={stage_data['report_id']})"
        print(f"  Stage {stage_name}: {stage_status}{extra}")

    # Check if background process is still running
    pid = state.get("pid")
    if pid and state.get("status") == "running":
        try:
            os.kill(pid, 0)  # Check if process exists
            print(f"  Process: running (pid={pid})")
        except OSError:
            print(f"  Process: not running (pid={pid} -- may have crashed)")

    return 0


def resume_pipeline(output_dir: Path, base_url: str, max_rounds: int) -> int:
    """Resume an interrupted pipeline from last completed stage."""
    state = _load_pipeline_state(output_dir)
    if state is None:
        print(
            "ERROR: No pipeline state found. Cannot resume.",
            file=sys.stderr,
        )
        return 1

    if state.get("status") == "completed":
        print("MiroFish: Pipeline already completed. Nothing to resume.")
        return 0

    prd_path = Path(state.get("prd_path", ""))
    if not prd_path.exists():
        print(
            f"ERROR: Original PRD not found at {prd_path}",
            file=sys.stderr,
        )
        return 1

    # Determine which stages are already completed
    stages = state.get("stages", {})
    completed_stages = set()
    for stage_name, stage_data in stages.items():
        if stage_data.get("status") == "completed":
            completed_stages.add(stage_name)

    if completed_stages:
        completed_list = ", ".join(sorted(completed_stages))
        print(f"MiroFish: Skipping completed stages: {completed_list}")

    # Find first incomplete stage to resume from
    resume_stage = 1
    for idx in range(1, 5):
        stage_key = list(stages.keys())[idx - 1] if idx - 1 < len(stages) else None
        if stage_key and stages.get(stage_key, {}).get("status") == "completed":
            resume_stage = idx + 1
        else:
            break

    if resume_stage > 4:
        print("MiroFish: All stages already completed.")
        return 0

    print(f"MiroFish: Resuming pipeline from stage {resume_stage}...")

    # Reset pipeline status for retry
    state["status"] = "running"
    state["current_stage"] = resume_stage
    state["error"] = None
    state["pid"] = os.getpid()
    _update_pipeline_state(output_dir, state)

    client = MiroFishClient(base_url=base_url)
    mf_dir = output_dir / "mirofish"

    try:
        context = extract_simulation_context(prd_path)

        # Recover IDs from completed stages
        project_id = stages.get("1_ontology", {}).get("project_id", "")
        graph_id = stages.get("2_graph", {}).get("graph_id", "")
        simulation_id = stages.get("3_simulation", {}).get("simulation_id", "")

        if resume_stage <= 1:
            # Stage 1: Ontology
            print("MiroFish Stage 1/4: Generating ontology...")
            onto_resp = client.generate_ontology(
                prd_path=str(prd_path),
                simulation_requirement=context["simulation_requirement"],
                project_name=context["project_name"],
            )
            onto_data = onto_resp.get("data", onto_resp)
            project_id = onto_data["project_id"]
            state["stages"]["1_ontology"] = {
                "status": "completed",
                "project_id": project_id,
                "completed_at": _now_iso(),
            }
            state["current_stage"] = 2
            _update_pipeline_state(output_dir, state)
            _write_json(mf_dir / "ontology.json", onto_resp)
            print(f"MiroFish Stage 1/4: Ontology complete (project={project_id})")

        if resume_stage <= 2:
            print("MiroFish Stage 2/4: Building knowledge graph...")
            build_resp = client.build_graph(project_id)
            build_data = build_resp.get("data", build_resp)
            task_id = build_data["task_id"]
            state["stages"]["2_graph"]["status"] = "running"
            state["stages"]["2_graph"]["task_id"] = task_id
            _update_pipeline_state(output_dir, state)
            graph_result = client.poll_graph_build(task_id)
            graph_id = graph_result.get("graph_id", "")
            state["stages"]["2_graph"] = {
                "status": "completed",
                "graph_id": graph_id,
                "completed_at": _now_iso(),
            }
            state["current_stage"] = 3
            _update_pipeline_state(output_dir, state)
            _write_json(mf_dir / "graph.json", graph_result)
            print(f"MiroFish Stage 2/4: Graph complete (graph_id={graph_id})")

        if resume_stage <= 3:
            print("MiroFish Stage 3/4: Running simulation...")
            sim_resp = client.create_simulation(project_id, graph_id)
            sim_data = sim_resp.get("data", sim_resp)
            simulation_id = sim_data["simulation_id"]
            state["stages"]["3_simulation"]["status"] = "running"
            state["stages"]["3_simulation"]["simulation_id"] = simulation_id
            _update_pipeline_state(output_dir, state)
            prep_resp = client.prepare_simulation(simulation_id)
            prep_data = prep_resp.get("data", prep_resp)
            prep_task_id = prep_data["task_id"]
            prep_result = client.poll_prepare(prep_task_id)
            start_resp = client.start_simulation(simulation_id, max_rounds=max_rounds)
            _write_json(mf_dir / "simulation-start.json", start_resp)
            sim_result = client.poll_run_status(simulation_id)
            state["stages"]["3_simulation"] = {
                "status": "completed",
                "simulation_id": simulation_id,
                "completed_at": _now_iso(),
            }
            state["current_stage"] = 4
            _update_pipeline_state(output_dir, state)
            _write_json(mf_dir / "simulation-result.json", sim_result)
            print(f"MiroFish Stage 3/4: Simulation complete (simulation_id={simulation_id})")
        else:
            # Need prep_result for normalize_report; load from saved state
            prep_result = {}

        if resume_stage <= 4:
            print("MiroFish Stage 4/4: Generating report...")
            report_resp = client.generate_report(simulation_id)
            report_data = report_resp.get("data", report_resp)
            report_task_id = report_data["task_id"]
            state["stages"]["4_report"]["status"] = "running"
            state["stages"]["4_report"]["task_id"] = report_task_id
            _update_pipeline_state(output_dir, state)
            report_result = client.poll_report(report_task_id)
            report_id = report_result.get("report_id", "")
            full_report = client.get_report(report_id)
            _write_json(mf_dir / "report.json", full_report)
            state["stages"]["4_report"] = {
                "status": "completed",
                "report_id": report_id,
                "completed_at": _now_iso(),
            }
            _update_pipeline_state(output_dir, state)
            print(f"MiroFish Stage 4/4: Report complete (report_id={report_id})")

            # Normalize and write final outputs
            normalized = normalize_report(full_report, simulation_data=prep_result if resume_stage <= 3 else {})
            tasks = build_mirofish_tasks(full_report)
            summary_md = _build_summary_markdown(normalized, tasks)
            _write_json(output_dir / "mirofish-context.json", normalized)
            _write_json(output_dir / "mirofish-tasks.json", tasks)
            _write_atomic(output_dir / "mirofish-summary.md", summary_md)

        state["status"] = "completed"
        state["completed_at"] = _now_iso()
        _update_pipeline_state(output_dir, state)
        print("MiroFish: Resume complete.")
        return 0

    except Exception as exc:
        state["status"] = "failed"
        state["error"] = str(exc)
        _update_pipeline_state(output_dir, state)
        print(f"ERROR: MiroFish resume failed: {exc}", file=sys.stderr)
        return 1


def main() -> None:
    parser = argparse.ArgumentParser(
        description="MiroFish Market Validation Adapter for Loki Mode",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 mirofish-adapter.py ./prd.md --output-dir .loki/\n"
            "  python3 mirofish-adapter.py ./prd.md --validate\n"
            "  python3 mirofish-adapter.py ./prd.md --json --url http://mf:5001\n"
            "  python3 mirofish-adapter.py --status --output-dir .loki/\n"
            "  python3 mirofish-adapter.py --health --url http://localhost:5001\n"
            "  python3 mirofish-adapter.py --docker-start --docker-image mirofish/app\n"
            "  python3 mirofish-adapter.py --docker-stop\n"
        ),
    )

    # Positional
    parser.add_argument("prd_path", nargs="?", help="Path to PRD file")

    # Modes
    parser.add_argument(
        "--validate", action="store_true", help="Validate PRD only"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Output as JSON to stdout",
    )
    parser.add_argument(
        "--status", action="store_true", help="Show pipeline status"
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume interrupted pipeline",
    )
    parser.add_argument(
        "--health", action="store_true", help="Health check only"
    )
    parser.add_argument(
        "--docker-start",
        action="store_true",
        help="Start MiroFish container",
    )
    parser.add_argument(
        "--docker-stop",
        action="store_true",
        help="Stop MiroFish container",
    )

    # Options
    parser.add_argument(
        "--output-dir", default=".loki", help="Output directory"
    )
    parser.add_argument(
        "--url", default=DEFAULT_URL, help="MiroFish API URL"
    )
    parser.add_argument(
        "--background",
        action="store_true",
        help="Run in background",
    )
    parser.add_argument(
        "--max-rounds",
        type=int,
        default=DEFAULT_MAX_ROUNDS,
        help="Maximum simulation rounds",
    )
    parser.add_argument(
        "--docker-image", help="Docker image for --docker-start"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="Port for Docker container",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=int(os.environ.get("LOKI_MIROFISH_TIMEOUT", str(DEFAULT_TIMEOUT))),
        help="Total pipeline timeout in seconds (default: 3600)",
    )

    args = parser.parse_args()

    # -- Route to appropriate handler --

    if args.docker_stop:
        ok = stop_container()
        sys.exit(0 if ok else 1)

    if args.docker_start:
        if not args.docker_image:
            print(
                "ERROR: --docker-image is required with --docker-start",
                file=sys.stderr,
            )
            sys.exit(1)
        ok = start_container(args.docker_image, port=args.port)
        sys.exit(0 if ok else 1)

    if args.health:
        client = MiroFishClient(base_url=args.url)
        ok = client.health_check()
        if ok:
            print(f"MiroFish: Healthy at {args.url}")
        else:
            print(f"MiroFish: NOT healthy at {args.url}", file=sys.stderr)
        sys.exit(0 if ok else 1)

    if args.status:
        output_dir = Path(args.output_dir)
        sys.exit(show_status(output_dir))

    if args.resume:
        output_dir = Path(args.output_dir)
        sys.exit(resume_pipeline(output_dir, args.url, args.max_rounds))

    # Remaining modes require prd_path
    if not args.prd_path:
        parser.error("prd_path is required for this mode")

    prd_path = Path(args.prd_path)

    if args.validate:
        sys.exit(validate_prd(prd_path, base_url=args.url))

    # Main pipeline run
    if not prd_path.exists():
        print(f"ERROR: PRD file not found: {prd_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)

    if args.as_json:
        # JSON mode: extract context and output to stdout (no pipeline)
        context = extract_simulation_context(prd_path)
        output = {
            "source": "mirofish",
            "prd_path": str(prd_path),
            "project_name": context["project_name"],
            "simulation_requirement": context["simulation_requirement"],
            "target_audience": context["target_audience"],
            "prd_summary": context["prd_summary"],
        }
        print(json.dumps(output, indent=2))
        sys.exit(0)

    if args.background:
        sys.exit(
            run_background(
                prd_path=str(prd_path),
                output_dir=str(output_dir),
                base_url=args.url,
                max_rounds=args.max_rounds,
                timeout=args.timeout,
            )
        )

    # Foreground pipeline run
    client = MiroFishClient(base_url=args.url)
    sys.exit(
        run_pipeline(
            client=client,
            prd_path=prd_path,
            output_dir=output_dir,
            max_rounds=args.max_rounds,
            timeout=args.timeout,
        )
    )


if __name__ == "__main__":
    main()
