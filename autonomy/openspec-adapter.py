#!/usr/bin/env python3
"""OpenSpec Change Adapter for Loki Mode

Parses OpenSpec change directories (proposal.md, specs/, design.md, tasks.md)
and normalizes them into Loki Mode's internal format. Bridges OpenSpec's
delta-based specification workflow into the .loki/ pipeline.

Stdlib only - no pip dependencies required. Python 3.9+.

Usage:
    python3 openspec-adapter.py <change-dir-path> [options]
      --output-dir DIR     Where to write output files (default: .loki/)
      --json               Output metadata as JSON to stdout
      --validate           Run artifact validation only
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


# -- Simple YAML Parsing (regex-based, no PyYAML) ----------------------------

def _parse_simple_yaml(text: str) -> Dict[str, Any]:
    """Parse simple YAML key-value pairs via regex.

    Handles scalars, quoted strings, and flow-style lists.
    Does NOT handle nested mappings or block-style lists.
    """
    metadata: Dict[str, Any] = {}
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^(\w[\w-]*):\s*(.*)", line)
        if not match:
            continue
        key = match.group(1)
        value = match.group(2).strip()
        # Flow-style list: [item1, item2]
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
    return metadata


def _unquote(s: str) -> str:
    """Remove surrounding quotes from a string."""
    if len(s) >= 2:
        if (s[0] == "'" and s[-1] == "'") or (s[0] == '"' and s[-1] == '"'):
            return s[1:-1]
    return s


# -- Proposal Parsing --------------------------------------------------------

def parse_proposal(proposal_path: Path) -> Dict[str, Any]:
    """Parse proposal.md into structured data.

    Extracts sections: Why, What Changes, Capabilities (New/Modified), Impact.
    """
    text = _safe_read(proposal_path)
    result: Dict[str, Any] = {
        "title": "",
        "why": "",
        "what_changes": "",
        "new_capabilities": [],
        "modified_capabilities": [],
        "impact": "",
    }

    # Extract title from H1 heading if present
    title_match = re.match(r"^#\s+(.+)", text.strip())
    if title_match:
        result["title"] = title_match.group(1).strip()

    # Extract sections by ## headings
    sections = _split_sections(text, level=2)

    for heading, body in sections.items():
        heading_lower = heading.lower().strip()
        if heading_lower == "why":
            result["why"] = body.strip()
        elif heading_lower == "what changes":
            result["what_changes"] = body.strip()
        elif heading_lower == "impact":
            result["impact"] = body.strip()
        elif heading_lower == "capabilities":
            # Parse sub-sections for New/Modified
            sub_sections = _split_sections(body, level=3)
            for sub_heading, sub_body in sub_sections.items():
                sub_lower = sub_heading.lower().strip()
                caps = _extract_capabilities(sub_body)
                if "new" in sub_lower:
                    result["new_capabilities"] = caps
                elif "modified" in sub_lower:
                    result["modified_capabilities"] = caps

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
        body = text[start:end].strip()
        if heading in sections:
            sections[heading] = sections[heading] + "\n\n" + body
        else:
            sections[heading] = body
    return sections


def _extract_capabilities(text: str) -> List[Dict[str, str]]:
    """Extract capability names and descriptions from bullet items.

    Matches patterns like:
      - `name`: description
      - **name:** description
    """
    capabilities: List[Dict[str, str]] = []
    # Pattern: - `name`: description
    for m in re.finditer(r"^-\s+`([^`]+)`:\s*(.+)", text, re.MULTILINE):
        capabilities.append({"name": m.group(1).strip(), "description": m.group(2).strip()})
    if capabilities:
        return capabilities
    # Fallback: - **name:** description
    for m in re.finditer(r"^-\s+\*\*([^*]+?):\*\*\s*(.+)", text, re.MULTILINE):
        capabilities.append({"name": m.group(1).strip(), "description": m.group(2).strip()})
    return capabilities


# -- Delta Spec Parsing -------------------------------------------------------

def parse_delta_spec(spec_path: Path) -> Dict[str, Any]:
    """Parse a delta spec.md file.

    Extracts ADDED, MODIFIED, and REMOVED requirements with their scenarios.
    """
    text = _safe_read(spec_path)
    result: Dict[str, List[Dict[str, Any]]] = {
        "added": [],
        "modified": [],
        "removed": [],
    }

    sections = _split_sections(text, level=2)

    for heading, body in sections.items():
        heading_lower = heading.lower().strip()
        if "added" in heading_lower:
            result["added"] = _parse_requirements(body, category="added")
        elif "modified" in heading_lower:
            result["modified"] = _parse_requirements(body, category="modified")
        elif "removed" in heading_lower:
            result["removed"] = _parse_requirements(body, category="removed")

    return result


def _parse_requirements(text: str, category: str = "added") -> List[Dict[str, Any]]:
    """Parse requirements from a delta section.

    Each requirement: ### Requirement: <name>
    With optional scenarios: #### Scenario: <name>
    """
    requirements: List[Dict[str, Any]] = []
    # Split by ### Requirement: headings
    req_pattern = re.compile(r"^###\s+Requirement:\s*(.+)$", re.MULTILINE)
    req_matches = list(req_pattern.finditer(text))

    for i, m in enumerate(req_matches):
        name = m.group(1).strip()
        start = m.end()
        end = req_matches[i + 1].start() if i + 1 < len(req_matches) else len(text)
        req_body = text[start:end].strip()

        req: Dict[str, Any] = {
            "name": name,
            "text": "",
            "scenarios": [],
        }

        # Extract previously annotation for modified requirements
        if category == "modified":
            # Try parenthesized format first: (Previously: ...)
            prev_match = re.search(r"\(Previously:\s*(.+?)\)", req_body)
            if not prev_match:
                # Try inline format: Previously ... (sentence boundary)
                prev_match = re.search(r"Previously\s+(.+?)(?:\.\s|\.$|\n|$)", req_body)
            if prev_match:
                req["previously"] = prev_match.group(1).strip().rstrip(".")

        # Extract deprecated/removed reason annotation
        if category == "removed":
            # Try parenthesized format first: (Deprecated: ...)
            dep_match = re.search(r"\(Deprecated(?::\s*(.+?))?\)", req_body)
            if dep_match:
                reason = dep_match.group(1)
                req["reason"] = reason.strip() if reason else ""
            else:
                # Try inline narrative: extract first sentence as reason
                # Look for patterns like "is removed", "was deprecated", etc.
                narrative = re.search(
                    r"(?:removed|deprecated|no longer|eliminated)[.\s]+(.+?)(?:\.\s|\.$|\n\n|$)",
                    req_body, re.IGNORECASE
                )
                if narrative:
                    req["reason"] = narrative.group(1).strip().rstrip(".")
                elif req_body.strip():
                    # Use first sentence of body as reason
                    first_sentence = req_body.strip().split(".")[0]
                    req["reason"] = first_sentence.strip()

        # Split into pre-scenario text and scenarios
        scenario_pattern = re.compile(r"^####\s+Scenario:\s*(.+)$", re.MULTILINE)
        scenario_matches = list(scenario_pattern.finditer(req_body))

        if scenario_matches:
            # Text before first scenario
            req["text"] = req_body[:scenario_matches[0].start()].strip()
            # Parse each scenario
            for j, sm in enumerate(scenario_matches):
                sc_name = sm.group(1).strip()
                sc_start = sm.end()
                sc_end = scenario_matches[j + 1].start() if j + 1 < len(scenario_matches) else len(req_body)
                sc_body = req_body[sc_start:sc_end].strip()
                scenario = _parse_scenario(sc_name, sc_body)
                req["scenarios"].append(scenario)
        else:
            # No scenarios -- entire body is the requirement text
            req["text"] = req_body

        requirements.append(req)

    return requirements


def _parse_scenario(name: str, body: str) -> Dict[str, Any]:
    """Parse a scenario body for GIVEN/WHEN/THEN lines.

    Handles two formats:
      - GIVEN ..., - WHEN ..., - THEN ... (list items)
      - **GIVEN** ..., **WHEN** ..., **THEN** ... (bold keywords)
    Also handles AND lines appended to the previous step.
    """
    scenario: Dict[str, Any] = {
        "name": name,
        "given": [],
        "when": [],
        "then": [],
    }

    for line in body.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue

        # Format 1: - **KEYWORD** text  or  - KEYWORD text
        m = re.match(
            r"^-\s+(?:\*\*)?(?:GIVEN|Given)(?:\*\*)?\s+(.+)",
            stripped,
        )
        if m:
            scenario["given"].append(m.group(1).strip())
            continue

        m = re.match(
            r"^-\s+(?:\*\*)?(?:WHEN|When)(?:\*\*)?\s+(.+)",
            stripped,
        )
        if m:
            scenario["when"].append(m.group(1).strip())
            continue

        m = re.match(
            r"^-\s+(?:\*\*)?(?:THEN|Then)(?:\*\*)?\s+(.+)",
            stripped,
        )
        if m:
            scenario["then"].append(m.group(1).strip())
            continue

        m = re.match(
            r"^-\s+(?:\*\*)?(?:AND|And)(?:\*\*)?\s+(.+)",
            stripped,
        )
        if m:
            # Append AND to the last non-empty list (then > when > given)
            and_text = m.group(1).strip()
            if scenario["then"]:
                scenario["then"].append(and_text)
            elif scenario["when"]:
                scenario["when"].append(and_text)
            elif scenario["given"]:
                scenario["given"].append(and_text)
            continue

    return scenario


# -- Tasks Parsing ------------------------------------------------------------

def parse_tasks(tasks_path: Path) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """Parse tasks.md into structured task list and source map.

    Returns:
        (tasks_list, source_map)
        tasks_list: list of task objects
        source_map: {task_id: {file, line, group}}
    """
    text = _safe_read(tasks_path)
    tasks: List[Dict[str, Any]] = []
    source_map: Dict[str, Dict[str, Any]] = {}
    current_group = ""

    for line_num, line in enumerate(text.split("\n"), start=1):
        stripped = line.strip()

        # Group heading: ## N. Group Name
        group_match = re.match(r"^##\s+(\d+)\.\s+(.+)", stripped)
        if group_match:
            current_group = group_match.group(2).strip()
            continue

        # Task item: - [ ] N.M description  or  - [x] N.M description
        task_match = re.match(r"^-\s+\[([ xX])\]\s+(\d+\.\d+)\s+(.*)", stripped)
        if task_match:
            checked = task_match.group(1).lower() == "x"
            task_id_num = task_match.group(2)
            description = task_match.group(3).strip()
            task_id = f"openspec-{task_id_num}"

            task = {
                "id": task_id,
                "title": description,
                "group": current_group,
                "status": "completed" if checked else "pending",
                "source": "tasks.md",
                "priority": "medium",
            }
            tasks.append(task)
            source_map[task_id] = {
                "file": "tasks.md",
                "line": line_num,
                "group": current_group,
            }

    return tasks, source_map


# -- Design Parsing -----------------------------------------------------------

def parse_design(design_path: Path) -> Dict[str, str]:
    """Parse design.md into structured sections.

    Extracts: Context, Goals/Non-Goals, Decisions, Risks/Trade-offs.
    """
    text = _safe_read(design_path)
    result: Dict[str, str] = {}

    sections = _split_sections(text, level=2)
    for heading, body in sections.items():
        heading_lower = heading.lower().strip()
        if "context" in heading_lower:
            result["context"] = body.strip()
        elif "goal" in heading_lower:
            result["goals"] = body.strip()
        elif "decision" in heading_lower:
            result["decisions"] = body.strip()
        elif "risk" in heading_lower or "trade" in heading_lower:
            result["risks"] = body.strip()
        else:
            # Preserve any other sections
            result[heading_lower.replace(" ", "_").replace("/", "_")] = body.strip()

    return result


# -- Metadata Parsing ---------------------------------------------------------

def parse_metadata(yaml_path: Path) -> Dict[str, Any]:
    """Parse .openspec.yaml for change metadata."""
    text = _safe_read(yaml_path)
    return _parse_simple_yaml(text)


# -- Complexity Classification ------------------------------------------------

def classify_complexity(
    num_tasks: int,
    num_spec_files: int,
    has_design: bool,
) -> str:
    """Classify change complexity from OpenSpec signals.

    Rules:
      - 1-3 tasks, 1 spec file, no design.md -> simple
      - 4-10 tasks, 2-5 spec files, design.md present -> standard
      - 11-20 tasks, 5-10 spec files -> complex
      - 20+ tasks or 10+ spec files -> enterprise
    """
    if num_tasks >= 20 or num_spec_files > 10:
        return "enterprise"
    if num_tasks > 10 or num_spec_files >= 5:
        return "complex"
    if num_tasks > 3 or num_spec_files > 1 or has_design:
        return "standard"
    return "simple"


# -- Validation ---------------------------------------------------------------

def validate_change(change_dir: Path) -> Tuple[List[str], List[str]]:
    """Validate an OpenSpec change directory.

    Returns (errors, warnings).
    """
    errors: List[str] = []
    warnings: List[str] = []

    # proposal.md must exist and have content
    proposal_path = change_dir / "proposal.md"
    if not proposal_path.exists():
        errors.append("proposal.md not found")
    elif proposal_path.stat().st_size == 0:
        errors.append("proposal.md is empty")
    else:
        text = _safe_read(proposal_path)
        # Check it has at least one non-comment, non-empty line
        content_lines = [
            l for l in text.split("\n")
            if l.strip() and not l.strip().startswith("<!--")
        ]
        if len(content_lines) < 2:
            warnings.append("proposal.md has very little content")

    # specs/ directory must exist with at least one spec.md
    specs_dir = change_dir / "specs"
    if not specs_dir.is_dir():
        errors.append("specs/ directory not found")
    else:
        spec_files = list(specs_dir.rglob("spec.md"))
        if not spec_files:
            errors.append("No spec.md files found under specs/")
        else:
            # Each spec.md should have at least one delta section
            for sf in spec_files:
                text = _safe_read(sf)
                has_delta = any(
                    re.search(rf"##\s+{keyword}\s+Requirements", text, re.IGNORECASE)
                    for keyword in ("ADDED", "MODIFIED", "REMOVED")
                )
                if not has_delta:
                    domain = sf.parent.name
                    warnings.append(
                        f"specs/{domain}/spec.md has no ADDED/MODIFIED/REMOVED sections"
                    )

    # tasks.md should exist (warn if missing)
    tasks_path = change_dir / "tasks.md"
    if not tasks_path.exists():
        warnings.append("tasks.md not found (no implementation checklist)")

    return errors, warnings


# -- Output Generation --------------------------------------------------------

def build_normalized_prd(
    change_name: str,
    proposal: Dict[str, Any],
    all_deltas: Dict[str, Dict[str, Any]],
    design: Optional[Dict[str, str]],
) -> str:
    """Build the synthesized PRD markdown from proposal + specs + design."""
    lines: List[str] = []
    lines.append(f"# OpenSpec Change: {change_name}")
    lines.append("")

    # Motivation
    lines.append("## Motivation")
    lines.append("")
    if proposal.get("why"):
        lines.append(proposal["why"])
    else:
        lines.append("(No motivation provided)")
    lines.append("")

    # Scope
    lines.append("## Scope")
    lines.append("")
    if proposal.get("what_changes"):
        lines.append(proposal["what_changes"])
    else:
        lines.append("(No scope provided)")
    lines.append("")

    # Requirements from all delta specs
    lines.append("## Requirements")
    lines.append("")
    for domain, deltas in sorted(all_deltas.items()):
        for category in ("added", "modified", "removed"):
            for req in deltas.get(category, []):
                tag = category.upper()
                lines.append(f"### {domain}: {req['name']} [{tag}]")
                lines.append("")
                if req.get("text"):
                    lines.append(req["text"])
                    lines.append("")
                if category == "modified" and req.get("previously"):
                    lines.append(f"(Previously: {req['previously']})")
                    lines.append("")
                if category == "removed" and req.get("reason"):
                    lines.append(f"(Deprecated: {req['reason']})")
                    lines.append("")
                for sc in req.get("scenarios", []):
                    lines.append(f"- Scenario: {sc['name']}")
                    for g in sc.get("given", []):
                        lines.append(f"  - GIVEN {g}")
                    for w in sc.get("when", []):
                        lines.append(f"  - WHEN {w}")
                    for t in sc.get("then", []):
                        lines.append(f"  - THEN {t}")
                    lines.append("")

    # Technical Design
    if design:
        lines.append("## Technical Design")
        lines.append("")
        for section_name, section_body in design.items():
            lines.append(f"### {section_name.replace('_', ' ').title()}")
            lines.append("")
            lines.append(section_body)
            lines.append("")

    return "\n".join(lines)


def build_delta_context(
    change_name: str,
    all_deltas: Dict[str, Dict[str, Any]],
    complexity: str,
) -> Dict[str, Any]:
    """Build the delta-context.json structure."""
    total = 0
    added = 0
    modified = 0
    removed = 0

    for deltas in all_deltas.values():
        a = len(deltas.get("added", []))
        m = len(deltas.get("modified", []))
        r = len(deltas.get("removed", []))
        added += a
        modified += m
        removed += r
        total += a + m + r

    return {
        "change_name": change_name,
        "deltas": all_deltas,
        "complexity": complexity,
        "stats": {
            "total_requirements": total,
            "added": added,
            "modified": modified,
            "removed": removed,
        },
    }


def build_verification_map(all_deltas: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Build verification-map.json from scenarios across all deltas."""
    scenarios: List[Dict[str, Any]] = []

    for domain, deltas in sorted(all_deltas.items()):
        for category in ("added", "modified"):
            for req in deltas.get(category, []):
                for sc in req.get("scenarios", []):
                    scenarios.append({
                        "domain": domain,
                        "requirement": req["name"],
                        "scenario": sc["name"],
                        "given": " ".join(sc.get("given", [])),
                        "when": " ".join(sc.get("when", [])),
                        "then": " ".join(sc.get("then", [])),
                        "verified": False,
                    })

    return {"scenarios": scenarios}


# -- Main Orchestration -------------------------------------------------------

def run(
    change_dir_path: str,
    output_dir: str = ".loki",
    as_json: bool = False,
    validate_only: bool = False,
) -> int:
    """Main entry point. Returns exit code (0 = success, 1 = errors)."""

    change_dir = Path(change_dir_path).resolve()
    if not change_dir.is_dir():
        print(f"ERROR: Not a directory: {change_dir}", file=sys.stderr)
        return 1

    change_name = change_dir.name

    # -- Validation mode --
    if validate_only:
        errors, warnings = validate_change(change_dir)
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        for warn in warnings:
            print(f"WARNING: {warn}", file=sys.stderr)
        if not errors and not warnings:
            print(f"OpenSpec validation: {change_name} -- OK")
        elif not errors:
            print(f"OpenSpec validation: {change_name} -- OK with {len(warnings)} warning(s)")
        else:
            print(f"OpenSpec validation: {change_name} -- FAILED ({len(errors)} error(s), {len(warnings)} warning(s))")
        return 1 if errors else 0

    # -- Parse proposal.md (required) --
    proposal_path = change_dir / "proposal.md"
    if not proposal_path.exists():
        print("ERROR: proposal.md not found", file=sys.stderr)
        return 1

    proposal = parse_proposal(proposal_path)

    # -- Parse delta specs --
    specs_dir = change_dir / "specs"
    all_deltas: Dict[str, Dict[str, Any]] = {}
    num_spec_files = 0

    if specs_dir.is_dir():
        for spec_file in sorted(specs_dir.rglob("spec.md")):
            domain = spec_file.parent.name
            deltas = parse_delta_spec(spec_file)
            all_deltas[domain] = deltas
            num_spec_files += 1

    if not all_deltas:
        print("ERROR: No spec files found under specs/", file=sys.stderr)
        return 1

    # -- Parse tasks.md (optional) --
    tasks_list: List[Dict[str, Any]] = []
    source_map: Dict[str, Dict[str, Any]] = {}
    tasks_path = change_dir / "tasks.md"
    if tasks_path.exists():
        tasks_list, source_map = parse_tasks(tasks_path)

    # -- Parse design.md (optional) --
    design_data: Optional[Dict[str, str]] = None
    design_path = change_dir / "design.md"
    has_design = design_path.exists()
    if has_design:
        design_data = parse_design(design_path)

    # -- Parse .openspec.yaml (optional) --
    yaml_metadata: Dict[str, Any] = {}
    yaml_path = change_dir / ".openspec.yaml"
    if yaml_path.exists():
        yaml_metadata = parse_metadata(yaml_path)

    # -- Classify complexity --
    complexity = classify_complexity(
        num_tasks=len(tasks_list),
        num_spec_files=num_spec_files,
        has_design=has_design,
    )

    # -- Build outputs --
    normalized_prd = build_normalized_prd(change_name, proposal, all_deltas, design_data)
    delta_context = build_delta_context(change_name, all_deltas, complexity)
    verification_map = build_verification_map(all_deltas)

    # -- JSON mode: output to stdout --
    if as_json:
        output = {
            "change_name": change_name,
            "complexity": complexity,
            "proposal": proposal,
            "deltas": all_deltas,
            "tasks": tasks_list,
            "metadata": yaml_metadata,
            "stats": delta_context["stats"],
        }
        print(json.dumps(output, indent=2))
        return 0

    # -- Write output files --
    if Path(output_dir).is_absolute():
        abs_output_dir = Path(output_dir)
    else:
        abs_output_dir = (Path.cwd() / output_dir).resolve()

    written: List[str] = []

    # .loki/openspec-prd-normalized.md
    prd_out = abs_output_dir / "openspec-prd-normalized.md"
    _write_atomic(prd_out, normalized_prd)
    written.append(str(prd_out))

    # .loki/openspec-tasks.json
    tasks_out = abs_output_dir / "openspec-tasks.json"
    _write_atomic(tasks_out, json.dumps(tasks_list, indent=2))
    written.append(str(tasks_out))

    # .loki/openspec/delta-context.json
    delta_out = abs_output_dir / "openspec" / "delta-context.json"
    _write_atomic(delta_out, json.dumps(delta_context, indent=2))
    written.append(str(delta_out))

    # .loki/openspec/source-map.json
    srcmap_out = abs_output_dir / "openspec" / "source-map.json"
    _write_atomic(srcmap_out, json.dumps(source_map, indent=2))
    written.append(str(srcmap_out))

    # .loki/openspec/verification-map.json
    verif_out = abs_output_dir / "openspec" / "verification-map.json"
    _write_atomic(verif_out, json.dumps(verification_map, indent=2))
    written.append(str(verif_out))

    # -- CLI summary --
    print(f"OpenSpec adapter: change={change_name} tasks={len(tasks_list)} specs={num_spec_files} complexity={complexity}")
    print(f"  Output files written to {abs_output_dir}/:")
    for path in written:
        print(f"    - {Path(path).name}")

    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenSpec Change Adapter for Loki Mode",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 openspec-adapter.py ./openspec/changes/add-dark-mode\n"
            "  python3 openspec-adapter.py ./openspec/changes/add-dark-mode --json\n"
            "  python3 openspec-adapter.py ./openspec/changes/add-dark-mode --validate\n"
            "  python3 openspec-adapter.py ./openspec/changes/add-dark-mode --output-dir .loki/\n"
        ),
    )
    parser.add_argument(
        "change_dir_path",
        help="Path to the OpenSpec change directory",
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
        dest="validate_only",
        help="Run artifact validation only",
    )

    args = parser.parse_args()
    exit_code = run(
        change_dir_path=args.change_dir_path,
        output_dir=args.output_dir,
        as_json=args.as_json,
        validate_only=args.validate_only,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
