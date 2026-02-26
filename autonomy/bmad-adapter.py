#!/usr/bin/env python3
"""BMAD Artifact Adapter for Loki Mode

Discovers, parses, and normalizes BMAD methodology artifacts into
Loki Mode's native format. Bridges BMAD workflow output into the
prd-analyzer.py and .loki/queue/ pipeline.

Stdlib only - no pip dependencies required. Python 3.9+.

Usage:
    python3 bmad-adapter.py <project-path> [options]
      --output-dir DIR     Where to write output files (default: .loki/)
      --json               Output metadata as JSON to stdout
      --validate           Run artifact chain validation
"""

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Maximum artifact file size (10 MB)
MAX_ARTIFACT_SIZE = 10 * 1024 * 1024


def _safe_read(path: Path) -> str:
    """Read a file with size limit and encoding safety."""
    size = path.stat().st_size
    if size > MAX_ARTIFACT_SIZE:
        raise ValueError(f"Artifact too large ({size} bytes, max {MAX_ARTIFACT_SIZE}): {path.name}")
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


# -- BMAD Workflow Definitions ------------------------------------------------

# Expected steps for each BMAD workflow type
WORKFLOW_STEPS = {
    "prd": [
        "init", "discovery", "vision", "executive-summary", "success",
        "journeys", "functional", "nonfunctional", "polish", "complete",
    ],
    "architecture": [
        "init", "context", "decisions", "patterns", "structure",
        "validation", "complete",
    ],
    "epics": [
        "validate-prerequisites", "design-epics", "create-stories",
        "final-validation",
    ],
}

# Standard BMAD output directory structure
BMAD_OUTPUT_DIR = "_bmad-output/planning-artifacts"
BMAD_CONFIG_DIR = "_bmad"


# -- YAML Frontmatter Parsing ------------------------------------------------

def parse_frontmatter(text: str) -> Tuple[Dict[str, Any], str]:
    """Extract YAML frontmatter from a markdown document.

    Returns (metadata_dict, body_without_frontmatter).
    Handles simple YAML: scalars, lists (flow-style only; block-style not supported), quoted strings.
    Does NOT require PyYAML -- uses regex-based extraction.
    """
    stripped = text.lstrip()
    if not stripped.startswith("---"):
        return {}, text

    # Find closing ---
    lines = stripped.split("\n")
    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        return {}, text

    frontmatter_lines = lines[1:end_idx]
    body = "\n".join(lines[end_idx + 1:]).lstrip("\n")
    metadata: Dict[str, Any] = {}

    for line in frontmatter_lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        match = re.match(r"^(\w[\w-]*):\s*(.*)", line)
        if not match:
            continue

        key = match.group(1)
        value = match.group(2).strip()

        # Flow-style list: [item1, item2, item3]
        if value.startswith("[") and value.endswith("]"):
            items = value[1:-1].split(",")
            metadata[key] = [_unquote(item.strip()) for item in items if item.strip()]
        # Quoted string
        elif (value.startswith("'") and value.endswith("'")) or \
             (value.startswith('"') and value.endswith('"')):
            metadata[key] = value[1:-1]
        # Plain scalar
        else:
            metadata[key] = value

    return metadata, body


def _unquote(s: str) -> str:
    """Remove surrounding quotes from a string."""
    if len(s) >= 2:
        if (s[0] == "'" and s[-1] == "'") or (s[0] == '"' and s[-1] == '"'):
            return s[1:-1]
    return s


# -- Artifact Discovery -------------------------------------------------------

class BmadArtifacts:
    """Container for discovered BMAD artifacts in a project directory."""

    def __init__(self, project_path: str):
        self.project_path = Path(project_path).resolve()
        self.prd_path: Optional[Path] = None
        self.architecture_path: Optional[Path] = None
        self.epics_path: Optional[Path] = None
        self.output_dir: Optional[Path] = None
        self.errors: List[str] = []
        self._discover()

    def _discover(self) -> None:
        """Find BMAD artifacts in the project directory."""
        # Check for custom output folder via _bmad/ config
        config_dir = self.project_path / BMAD_CONFIG_DIR
        if config_dir.is_dir():
            config_file = config_dir / "config.json"
            if config_file.exists():
                try:
                    with open(config_file, "r", encoding="utf-8") as f:
                        config = json.load(f)
                    custom_output = config.get("outputDir", "")
                    if custom_output:
                        candidate = (self.project_path / custom_output / "planning-artifacts").resolve()
                        # Ensure resolved path stays within the project root
                        if candidate.is_dir() and str(candidate).startswith(str(self.project_path) + os.sep):
                            self.output_dir = candidate
                except (json.JSONDecodeError, OSError):
                    pass

        # Default output directory
        if self.output_dir is None:
            default_dir = self.project_path / BMAD_OUTPUT_DIR
            if default_dir.is_dir():
                self.output_dir = default_dir
            else:
                self.errors.append(
                    f"BMAD output directory not found: {BMAD_OUTPUT_DIR}"
                )
                return

        # Find PRD: prd-*.md or prd.md
        prd_candidates = sorted(self.output_dir.glob("prd-*.md"))
        if prd_candidates:
            self.prd_path = prd_candidates[0]
        else:
            prd_fallback = self.output_dir / "prd.md"
            if prd_fallback.exists():
                self.prd_path = prd_fallback
            else:
                self.errors.append("No PRD file found (expected prd-*.md or prd.md)")

        # Find architecture.md (optional)
        arch_path = self.output_dir / "architecture.md"
        if arch_path.exists():
            self.architecture_path = arch_path

        # Find epics.md (optional)
        epics_path = self.output_dir / "epics.md"
        if epics_path.exists():
            self.epics_path = epics_path

    @property
    def is_valid(self) -> bool:
        """True if at least a PRD was found."""
        return self.prd_path is not None

    def inventory(self) -> Dict[str, Optional[str]]:
        """Return artifact paths as strings (or None if missing)."""
        return {
            "prd": str(self.prd_path) if self.prd_path else None,
            "architecture": str(self.architecture_path) if self.architecture_path else None,
            "epics": str(self.epics_path) if self.epics_path else None,
        }


# -- Workflow Completeness ----------------------------------------------------

def assess_workflow(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Assess workflow completeness from frontmatter metadata.

    Returns dict with:
      - workflow_type: str
      - steps_completed: list
      - steps_expected: list
      - completion_pct: float (0-100)
      - is_complete: bool
    """
    workflow_type = metadata.get("workflowType", "unknown")
    steps_completed = metadata.get("stepsCompleted", [])
    if isinstance(steps_completed, str):
        steps_completed = [steps_completed]

    steps_expected = WORKFLOW_STEPS.get(workflow_type, [])
    if steps_expected:
        pct = round(len(steps_completed) / len(steps_expected) * 100, 1)
    else:
        pct = 0.0 if not steps_completed else 100.0

    return {
        "workflow_type": workflow_type,
        "steps_completed": steps_completed,
        "steps_expected": steps_expected,
        "completion_pct": pct,
        "is_complete": "complete" in steps_completed or "final-validation" in steps_completed,
    }


# -- Project Classification Extraction ----------------------------------------

def extract_classification(body: str) -> Dict[str, str]:
    """Extract Project Classification metadata from the PRD body.

    Looks for a '## Project Classification' section with bullet items like:
      - **Project Type:** web_app
    """
    classification: Dict[str, str] = {}

    # Find the classification section
    match = re.search(
        r"##\s+Project Classification\s*\n(.*?)(?=\n##\s|\Z)",
        body,
        re.DOTALL,
    )
    if not match:
        return classification

    section = match.group(1)
    # Extract key-value pairs from bold-label bullets
    # Handles both **Key:** value (colon inside bold) and **Key**: value (colon outside)
    for m in re.finditer(r"\*\*(.+?):\*\*\s*(.+)", section):
        key = m.group(1).strip().lower().replace(" ", "_")
        value = m.group(2).strip()
        classification[key] = value
    if not classification:
        # Fallback: colon outside bold markers
        for m in re.finditer(r"\*\*(.+?)\*\*:\s*(.+)", section):
            key = m.group(1).strip().lower().replace(" ", "_")
            value = m.group(2).strip()
            classification[key] = value

    return classification


# -- PRD Normalization --------------------------------------------------------

def normalize_prd(prd_path: Path) -> Tuple[Dict[str, Any], str]:
    """Read a BMAD PRD, strip frontmatter, return (metadata, clean_body).

    The clean body preserves all section headings as-is with no
    destructive remapping. Suitable for feeding into prd-analyzer.py.
    """
    text = _safe_read(prd_path)
    metadata, body = parse_frontmatter(text)
    return metadata, body


# -- Epic/Story Extraction ----------------------------------------------------

def parse_epics(epics_path: Path) -> List[Dict[str, Any]]:
    """Parse epics.md into structured JSON.

    Returns:
        [
            {
                "epic": "Epic 1: Core Task Board",
                "description": "...",
                "stories": [
                    {
                        "id": "1.1",
                        "title": "Task CRUD",
                        "as_a": "team member",
                        "i_want": "create, edit, and delete tasks",
                        "so_that": "I can track my work items.",
                        "acceptance_criteria": ["Given...When...Then..."]
                    }
                ]
            }
        ]
    """
    text = _safe_read(epics_path)
    _, body = parse_frontmatter(text)

    epics: List[Dict[str, Any]] = []
    current_epic: Optional[Dict[str, Any]] = None
    current_story: Optional[Dict[str, Any]] = None
    in_acceptance = False
    acceptance_lines: List[str] = []

    def _flush_acceptance() -> None:
        """Flush accumulated acceptance criteria lines into current story."""
        nonlocal in_acceptance, acceptance_lines
        if current_story is not None and acceptance_lines:
            criteria_text = " ".join(acceptance_lines).strip()
            if criteria_text:
                current_story["acceptance_criteria"].append(criteria_text)
            acceptance_lines = []

    for line in body.split("\n"):
        stripped = line.strip()

        # Epic heading: ## Epic N: Title
        epic_match = re.match(r"^##\s+(Epic\s+\d+.*)", stripped)
        if epic_match:
            # Flush any pending acceptance criteria
            _flush_acceptance()
            in_acceptance = False
            current_story = None

            epic_title = epic_match.group(1).strip()
            current_epic = {
                "epic": epic_title,
                "description": "",
                "stories": [],
            }
            epics.append(current_epic)
            continue

        # Story heading: ### Story N.M: Title
        story_match = re.match(r"^###\s+Story\s+(\d+\.\d+):\s*(.*)", stripped)
        if story_match and current_epic is not None:
            _flush_acceptance()
            in_acceptance = False

            story_id = story_match.group(1)
            story_title = story_match.group(2).strip()
            current_story = {
                "id": story_id,
                "title": story_title,
                "as_a": "",
                "i_want": "",
                "so_that": "",
                "acceptance_criteria": [],
            }
            current_epic["stories"].append(current_story)
            continue

        # Inside a story: parse user story format
        if current_story is not None:
            # "As a ..."
            as_match = re.match(r"^As an?\s+(.+),?\s*$", stripped)
            if as_match:
                _flush_acceptance()
                in_acceptance = False
                current_story["as_a"] = as_match.group(1).rstrip(",")
                continue

            # "I want ..."
            want_match = re.match(r"^I want(?:\s+to)?\s+(.+),?\s*$", stripped)
            if want_match:
                current_story["i_want"] = want_match.group(1).rstrip(",")
                continue

            # "So that ..."
            so_match = re.match(r"^So that\s+(.+)", stripped)
            if so_match:
                current_story["so_that"] = so_match.group(1).rstrip(".")
                continue

            # Acceptance Criteria header
            if stripped.startswith("**Acceptance Criteria:**"):
                _flush_acceptance()
                in_acceptance = True
                continue

            # Acceptance criteria lines (Given/When/Then/And)
            if in_acceptance:
                ac_match = re.match(r"^\*\*(\w+)\*\*\s+(.*)", stripped)
                if ac_match:
                    keyword = ac_match.group(1)
                    text_part = ac_match.group(2)
                    if keyword in ("Given", "When"):
                        # Flush previous criterion on a new Given/When
                        if keyword == "Given":
                            _flush_acceptance()
                        acceptance_lines.append(f"{keyword} {text_part}")
                    elif keyword in ("Then", "And"):
                        acceptance_lines.append(f"{keyword} {text_part}")
                    continue
                # Non-AC line while in acceptance -> end
                if stripped and not stripped.startswith("**"):
                    _flush_acceptance()
                    in_acceptance = False

        # Epic description (text right after epic heading, before first story)
        if current_epic is not None and current_story is None and stripped:
            if not stripped.startswith("#") and not stripped.startswith("- "):
                if current_epic["description"]:
                    current_epic["description"] += " " + stripped
                else:
                    current_epic["description"] = stripped

    # Flush any remaining acceptance criteria
    _flush_acceptance()

    return epics


# -- Architecture Summary -----------------------------------------------------

def summarize_architecture(arch_path: Path) -> str:
    """Produce a condensed architecture summary for prompt injection.

    Extracts key decision sections and the project structure block.
    """
    text = _safe_read(arch_path)
    _, body = parse_frontmatter(text)

    sections_to_keep = [
        "Core Architectural Decisions",
        "Implementation Patterns",
        "Project Structure",
    ]

    lines = body.split("\n")
    output_lines: List[str] = []
    capturing = False
    current_level = 0

    for line in lines:
        heading_match = re.match(r"^(#{1,3})\s+(.*)", line)
        if heading_match:
            level = len(heading_match.group(1))
            title = heading_match.group(2).strip()

            # Check if this is a section we want
            if any(s.lower() in title.lower() for s in sections_to_keep):
                capturing = True
                current_level = level
                output_lines.append(line)
                continue
            # If same or higher level heading, stop capturing
            if capturing and level <= current_level:
                capturing = False

        if capturing:
            output_lines.append(line)

    summary = "\n".join(output_lines).strip()
    if not summary:
        # Fallback: return full body (minus frontmatter)
        summary = body.strip()

    return summary


# -- Artifact Chain Validation ------------------------------------------------

def validate_chain(
    artifacts: BmadArtifacts,
    prd_body: str,
    epics_data: Optional[List[Dict[str, Any]]],
    prd_metadata: Dict[str, Any],
) -> List[Dict[str, str]]:
    """Validate the BMAD artifact chain for completeness and consistency.

    Checks:
      1. PRD references product-brief themes (inputDocuments)
      2. FR coverage in epics (which FRs have stories)
      3. Missing artifacts warnings
      4. Uncovered FRs warnings

    Returns a list of {level: "warning"|"info"|"error", message: str}.
    """
    findings: List[Dict[str, str]] = []

    # 1. Check if PRD references input documents
    input_docs = prd_metadata.get("inputDocuments", [])
    if not input_docs:
        findings.append({
            "level": "warning",
            "message": "PRD frontmatter has no inputDocuments -- cannot verify product-brief linkage.",
        })
    else:
        docs = input_docs if isinstance(input_docs, list) else [input_docs] if input_docs else []
        findings.append({
            "level": "info",
            "message": f"PRD references input documents: {', '.join(docs)}",
        })

    # 2. Missing artifacts
    if artifacts.architecture_path is None:
        findings.append({
            "level": "warning",
            "message": "Architecture document not found. Technical decisions are not documented.",
        })

    if artifacts.epics_path is None:
        findings.append({
            "level": "warning",
            "message": "Epics document not found. No story breakdown available.",
        })

    # 3. Extract FRs from PRD body
    fr_pattern = re.compile(r"\b(FR\d+)\b")
    prd_frs = set(fr_pattern.findall(prd_body))

    if not prd_frs:
        findings.append({
            "level": "warning",
            "message": "No functional requirements (FRnn) found in PRD body.",
        })
    else:
        findings.append({
            "level": "info",
            "message": f"PRD defines {len(prd_frs)} functional requirements: {', '.join(sorted(prd_frs))}",
        })

    # 4. Check FR coverage in epics
    if epics_data is not None and prd_frs:
        # Parse the epics.md body directly for FR references
        epics_text = ""
        if artifacts.epics_path:
            epics_text = _safe_read(artifacts.epics_path)

        covered_frs = set(fr_pattern.findall(epics_text))
        uncovered = prd_frs - covered_frs
        if uncovered:
            findings.append({
                "level": "warning",
                "message": f"Uncovered functional requirements (no epic/story): {', '.join(sorted(uncovered))}",
            })
        else:
            findings.append({
                "level": "info",
                "message": "All functional requirements are covered by epics.",
            })

    # 5. Workflow completeness checks
    if artifacts.prd_path:
        workflow = assess_workflow(prd_metadata)
        if not workflow["is_complete"]:
            findings.append({
                "level": "warning",
                "message": (
                    f"PRD workflow is incomplete ({workflow['completion_pct']}%). "
                    f"Completed: {', '.join(workflow['steps_completed'])}. "
                    f"Expected: {', '.join(workflow['steps_expected'])}."
                ),
            })

    return findings


# -- Output File Generation ---------------------------------------------------

def write_outputs(
    output_dir: Path,
    metadata: Dict[str, Any],
    normalized_prd: str,
    arch_summary: Optional[str],
    tasks_json: Optional[List[Dict[str, Any]]],
    validation_report: Optional[List[Dict[str, str]]],
) -> List[str]:
    """Write all output files to the specified directory.

    Returns list of written file paths.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    written: List[str] = []

    # bmad-metadata.json
    meta_path = output_dir / "bmad-metadata.json"
    _write_atomic(meta_path, json.dumps(metadata, indent=2))
    written.append(str(meta_path))

    # bmad-prd-normalized.md
    prd_path = output_dir / "bmad-prd-normalized.md"
    _write_atomic(prd_path, normalized_prd)
    written.append(str(prd_path))

    # bmad-architecture-summary.md
    if arch_summary is not None:
        arch_path = output_dir / "bmad-architecture-summary.md"
        _write_atomic(arch_path, arch_summary)
        written.append(str(arch_path))

    # bmad-tasks.json
    if tasks_json is not None:
        tasks_path = output_dir / "bmad-tasks.json"
        _write_atomic(tasks_path, json.dumps(tasks_json, indent=2))
        written.append(str(tasks_path))

    # bmad-validation.md
    if validation_report is not None:
        val_path = output_dir / "bmad-validation.md"
        val_lines = ["# BMAD Artifact Chain Validation Report\n"]
        for item in validation_report:
            level = item["level"].upper()
            val_lines.append(f"- [{level}] {item['message']}")
        _write_atomic(val_path, "\n".join(val_lines) + "\n")
        written.append(str(val_path))

    return written


# -- Main Orchestration -------------------------------------------------------

def run(
    project_path: str,
    output_dir: str = ".loki",
    as_json: bool = False,
    validate: bool = False,
) -> int:
    """Main entry point. Returns exit code (0 = success, 1 = errors)."""

    # 1. Discover artifacts
    artifacts = BmadArtifacts(project_path)

    if not artifacts.is_valid:
        for err in artifacts.errors:
            print(f"ERROR: {err}", file=sys.stderr)
        print(
            "This does not appear to be a BMAD project. "
            f"Expected {BMAD_OUTPUT_DIR}/ with a prd-*.md or prd.md file.",
            file=sys.stderr,
        )
        return 1

    # 2. Parse PRD
    prd_metadata, prd_body = normalize_prd(artifacts.prd_path)  # type: ignore[arg-type]
    classification = extract_classification(prd_body)
    workflow = assess_workflow(prd_metadata)

    # 3. Parse architecture (optional)
    arch_summary: Optional[str] = None
    if artifacts.architecture_path:
        arch_summary = summarize_architecture(artifacts.architecture_path)

    # 4. Parse epics (optional)
    epics_data: Optional[List[Dict[str, Any]]] = None
    if artifacts.epics_path:
        epics_data = parse_epics(artifacts.epics_path)

    # 5. Build combined metadata
    combined_metadata: Dict[str, Any] = {
        "project_classification": classification,
        "workflow": workflow,
        "artifacts": artifacts.inventory(),
        "frontmatter": prd_metadata,
    }

    # 6. Validation (optional)
    validation_report: Optional[List[Dict[str, str]]] = None
    if validate:
        validation_report = validate_chain(
            artifacts, prd_body, epics_data, prd_metadata,
        )

    # 7. JSON output to stdout
    if as_json:
        output = {
            "metadata": combined_metadata,
        }
        if validation_report is not None:
            output["validation"] = validation_report
        if epics_data is not None:
            output["epics"] = epics_data
        print(json.dumps(output, indent=2))
        return 0

    # 8. Write output files
    output_path = Path(output_dir)
    if output_path.is_absolute():
        abs_output_dir = output_path
    else:
        abs_output_dir = (Path(project_path).resolve() / output_dir).resolve()
    written = write_outputs(
        output_dir=abs_output_dir,
        metadata=combined_metadata,
        normalized_prd=prd_body,
        arch_summary=arch_summary,
        tasks_json=epics_data,
        validation_report=validation_report,
    )

    print(f"BMAD adapter: processed {artifacts.prd_path}")
    print(f"  Workflow: {workflow['workflow_type']} ({workflow['completion_pct']}% complete)")
    if classification:
        print(f"  Classification: {classification.get('project_type', 'unknown')} / {classification.get('complexity', 'unknown')}")
    print(f"  Artifacts: PRD={'found' if artifacts.prd_path else 'MISSING'}, "
          f"Architecture={'found' if artifacts.architecture_path else 'missing'}, "
          f"Epics={'found' if artifacts.epics_path else 'missing'}")
    print(f"  Output files written to {abs_output_dir}/:")
    for path in written:
        print(f"    - {Path(path).name}")

    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="BMAD Artifact Adapter for Loki Mode",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 bmad-adapter.py ./my-project\n"
            "  python3 bmad-adapter.py ./my-project --json\n"
            "  python3 bmad-adapter.py ./my-project --validate\n"
            "  python3 bmad-adapter.py ./my-project --output-dir .loki/ --validate\n"
        ),
    )
    parser.add_argument(
        "project_path",
        help="Path to the project directory containing BMAD artifacts",
    )
    parser.add_argument(
        "--output-dir",
        default=".loki",
        help="Where to write output files (default: .loki/)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Output metadata as JSON to stdout (no files written)",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Run artifact chain validation",
    )

    args = parser.parse_args()
    exit_code = run(
        project_path=args.project_path,
        output_dir=args.output_dir,
        as_json=args.as_json,
        validate=args.validate,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
