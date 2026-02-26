#!/usr/bin/env python3
"""PRD Quality Analyzer for Loki Mode v6.1.0

Analyzes PRD structure and completeness using regex-based heuristics.
Writes observations to .loki/prd-observations.md with quality score,
strengths, gaps, assumptions, and recommendations.

Stdlib only - no pip dependencies required.

Usage:
    python3 prd-analyzer.py path/to/prd.md --output .loki/prd-observations.md
    python3 prd-analyzer.py path/to/prd.md --output .loki/prd-observations.md --interactive
    python3 prd-analyzer.py path/to/prd.md --architecture path/to/architecture.md
"""

import argparse
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


# Analysis dimensions with their detection patterns and weights
DIMENSIONS = {
    "feature_list": {
        "label": "Feature List",
        "weight": 1.5,
        "heading_patterns": [
            r"(?i)#+\s.*(?:feature|requirement|scope|functional|capability)",
            r"(?i)^##\s+Functional\s+Requirements",
            r"(?i)^##\s+Product\s+Scope",
        ],
        "content_patterns": [
            r"^\s*[-*]\s+\S",
            r"^\s*\d+\.\s+\S",
            r"(?i)^FR\d+:",
        ],
        "description": "Numbered or bulleted list of features/requirements",
    },
    "tech_stack": {
        "label": "Tech Stack",
        "weight": 1.0,
        "heading_patterns": [
            r"(?i)#+\s.*(?:tech|stack|technology|architecture|infrastructure)",
        ],
        "content_patterns": [
            r"(?i)\b(?:react|vue|angular|svelte|next\.?js|nuxt)\b",
            r"(?i)\b(?:node\.?js|express|fastapi|django|flask|rails|spring)\b",
            r"(?i)\b(?:python|typescript|javascript|rust|go|java|ruby)\b",
            r"(?i)\b(?:postgres|mysql|sqlite|mongodb|redis|dynamodb)\b",
            r"(?i)\b(?:docker|kubernetes|k8s|aws|gcp|azure|vercel|netlify)\b",
        ],
        "description": "Technology choices and architecture",
    },
    "user_stories": {
        "label": "User Stories / Flows",
        "weight": 1.0,
        "heading_patterns": [
            r"(?i)#+\s.*(?:user\s+(?:stor|flow|journey)|persona|use\s+case)",
            r"(?i)^##\s+User\s+Journeys",
        ],
        "content_patterns": [
            r"(?i)\bas\s+a\s+\w+",
            r"(?i)\buser\s+(?:can|should|will|must|wants?\s+to)\b",
            r"(?i)\bso\s+that\s+\w+",
        ],
        "description": "User stories, personas, or user flow descriptions",
    },
    "acceptance_criteria": {
        "label": "Acceptance Criteria",
        "weight": 1.0,
        "heading_patterns": [
            r"(?i)#+\s.*(?:acceptance|criteria|definition\s+of\s+done|done\s+when)",
            r"(?i)^##\s+Success\s+Criteria",
        ],
        "content_patterns": [
            r"^\s*-\s*\[\s*[xX ]?\s*\]",
            r"(?i)\bgiven\b.*\bwhen\b.*\bthen\b",
            r"(?i)\bmust\s+(?:be|have|support|handle)\b",
            r"(?i)^\s*\*\*Given\*\*",
        ],
        "description": "Measurable completion criteria or checklists",
    },
    "data_model": {
        "label": "Data Model / Schema",
        "weight": 1.0,
        "heading_patterns": [
            r"(?i)#+\s.*(?:data\s*(?:base|model)|schema|entit|table|erd)",
        ],
        "content_patterns": [
            r"(?i)\b(?:database|schema|model|table|entity|collection)\b",
            r"(?i)\b(?:primary\s+key|foreign\s+key|index|relation)\b",
            r"(?i)\b(?:one-to-many|many-to-many|has_many|belongs_to)\b",
        ],
        "description": "Database schema, data models, or entity definitions",
    },
    "api_spec": {
        "label": "API Specifications",
        "weight": 1.0,
        "heading_patterns": [
            r"(?i)#+\s.*(?:api|endpoint|route|rest|graphql)",
        ],
        "content_patterns": [
            r"(?i)\b(?:GET|POST|PUT|PATCH|DELETE)\s+/",
            r"(?i)\b(?:endpoint|route|api)\b.*\b(?:GET|POST|PUT|DELETE)\b",
            r"(?i)\b(?:request|response)\s+(?:body|payload|schema)\b",
        ],
        "description": "API endpoints, request/response formats",
    },
    "deployment": {
        "label": "Deployment Requirements",
        "weight": 0.75,
        "heading_patterns": [
            r"(?i)#+\s.*(?:deploy|hosting|infra|ci.?cd|environment)",
        ],
        "content_patterns": [
            r"(?i)\b(?:deploy|hosting|ci.?cd|pipeline|staging|production)\b",
            r"(?i)\b(?:docker|container|serverless|lambda|cloud\s*run)\b",
        ],
        "description": "Deployment targets, CI/CD, and infrastructure",
    },
    "error_handling": {
        "label": "Error Handling",
        "weight": 0.75,
        "heading_patterns": [
            r"(?i)#+\s.*(?:error|exception|failure|fallback|edge\s+case)",
        ],
        "content_patterns": [
            r"(?i)\b(?:error\s+handl|exception|fallback|retry|timeout)\b",
            r"(?i)\b(?:edge\s+case|failure\s+mode|graceful|degraded)\b",
        ],
        "description": "Error handling, edge cases, and failure modes",
    },
    "security": {
        "label": "Security Requirements",
        "weight": 1.0,
        "heading_patterns": [
            r"(?i)#+\s.*(?:security|auth|permission|access\s+control)",
            r"(?i)^##\s+Non-Functional\s+Requirements",
        ],
        "content_patterns": [
            r"(?i)\b(?:auth(?:entication|orization)?|oauth|jwt|token)\b",
            r"(?i)\b(?:security|permission|role|rbac|encrypt|ssl|tls|https)\b",
            r"(?i)\b(?:password|credential|secret|api\s*key)\b",
        ],
        "description": "Authentication, authorization, and security measures",
    },
}

# Scope estimation based on feature count
SCOPE_THRESHOLDS = [
    (5, "small"),
    (15, "medium"),
    (30, "large"),
    (999999, "enterprise"),
]


class PrdAnalyzer:
    """Analyzes PRD quality and completeness."""

    def __init__(self, prd_path, architecture_path=None):
        self.prd_path = Path(prd_path)
        self.architecture_path = Path(architecture_path) if architecture_path else None
        self.content = ""
        self.lines = []
        self.results = {}
        self.feature_count = 0
        self.scope = "unknown"
        self.score = 0.0

    def load(self):
        """Load and validate the PRD file, optionally appending architecture doc."""
        if not self.prd_path.exists():
            raise FileNotFoundError(f"PRD file not found: {self.prd_path}")
        self.content = self.prd_path.read_text(encoding="utf-8", errors="replace")
        if not self.content.strip():
            raise ValueError(f"PRD file is empty: {self.prd_path}")
        self.lines = self.content.splitlines()
        # Append architecture document lines for pattern matching
        if self.architecture_path:
            if not self.architecture_path.exists():
                raise FileNotFoundError(f"Architecture file not found: {self.architecture_path}")
            arch_content = self.architecture_path.read_text(encoding="utf-8", errors="replace")
            if arch_content.strip():
                self.lines.extend(arch_content.splitlines())

    def analyze(self):
        """Run all analysis dimensions and compute score."""
        self.load()
        total_weight = 0.0
        earned_weight = 0.0

        for key, dim in DIMENSIONS.items():
            found_heading = False
            found_content = False
            matches = []

            # Check for relevant headings
            for pattern in dim["heading_patterns"]:
                for line in self.lines:
                    if re.search(pattern, line):
                        found_heading = True
                        break
                if found_heading:
                    break

            # Check for content patterns
            for pattern in dim["content_patterns"]:
                for line in self.lines:
                    m = re.search(pattern, line)
                    if m:
                        found_content = True
                        matches.append(line.strip()[:120])
                        if len(matches) >= 5:
                            break
                if len(matches) >= 5:
                    break

            detected = found_heading or found_content
            confidence = "high" if (found_heading and found_content) else "partial" if detected else "none"

            self.results[key] = {
                "label": dim["label"],
                "detected": detected,
                "confidence": confidence,
                "has_heading": found_heading,
                "has_content": found_content,
                "sample_matches": matches[:3],
                "weight": dim["weight"],
                "description": dim["description"],
            }

            total_weight += dim["weight"]
            if confidence == "high":
                earned_weight += dim["weight"]
            elif confidence == "partial":
                earned_weight += dim["weight"] * 0.5

        # Compute score (0-10 scale)
        self.score = round((earned_weight / total_weight) * 10, 1) if total_weight > 0 else 0.0

        # Count features for scope estimation
        self._estimate_scope()

        return self.results

    def _estimate_scope(self):
        """Estimate project scope from feature count."""
        count = 0
        in_feature_section = False
        for line in self.lines:
            if re.search(r"(?i)#+\s.*(?:feature|requirement|scope|functional)", line):
                in_feature_section = True
                continue
            if in_feature_section and re.match(r"^\s*#+\s", line):
                in_feature_section = False
                continue
            if in_feature_section:
                if re.match(r"^\s*[-*]\s+\S", line) or re.match(r"^\s*\d+\.\s+\S", line):
                    count += 1

        self.feature_count = count
        for threshold, label in SCOPE_THRESHOLDS:
            if count <= threshold:
                self.scope = label
                break

    def generate_observations(self):
        """Generate the observations markdown content."""
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        strengths = []
        missing = []
        assumptions = []
        recommendations = []

        for key, result in self.results.items():
            label = result["label"]
            if result["confidence"] == "high":
                strengths.append(f"- **{label}**: Well-defined with dedicated section and content")
            elif result["confidence"] == "partial":
                strengths.append(f"- **{label}**: Partially covered (mentioned but lacks dedicated section)")
                recommendations.append(f"- Add a dedicated **{label}** section with more detail")
            else:
                missing.append(f"- **{label}**: {result['description']}")
                assumptions.append(self._make_assumption(key))
                recommendations.append(f"- Add **{label}** section: {result['description']}")

        lines = [
            f"# PRD Analysis Observations",
            f"",
            f"**Source:** `{self.prd_path}`",
            f"**Analyzed:** {now}",
            f"**Quality Score:** {self.score}/10",
            f"**Estimated Scope:** {self.scope} (~{self.feature_count} items detected)",
            f"",
            f"## Strengths",
            f"",
        ]
        if strengths:
            lines.extend(strengths)
        else:
            lines.append("- No well-defined sections detected")
        lines.append("")

        lines.append("## Missing or Unclear")
        lines.append("")
        if missing:
            lines.extend(missing)
        else:
            lines.append("- All key dimensions are covered")
        lines.append("")

        lines.append("## Assumptions Made")
        lines.append("")
        if assumptions:
            lines.extend([a for a in assumptions if a])
        else:
            lines.append("- No assumptions needed; PRD is comprehensive")
        lines.append("")

        lines.append("## Recommended Additions")
        lines.append("")
        if recommendations:
            lines.extend(recommendations)
        else:
            lines.append("- PRD is well-structured; no major additions needed")
        lines.append("")

        return "\n".join(lines)

    def _make_assumption(self, key):
        """Generate a reasonable assumption for a missing dimension."""
        assumptions_map = {
            "feature_list": "- Will extract features from prose descriptions",
            "tech_stack": "- Will infer tech stack from context or use common defaults",
            "user_stories": "- Will derive user flows from feature descriptions",
            "acceptance_criteria": "- Will generate acceptance criteria from requirements",
            "data_model": "- Will design data model based on feature requirements",
            "api_spec": "- Will define API endpoints based on feature set",
            "deployment": "- Will use standard containerized deployment",
            "error_handling": "- Will implement standard error handling patterns",
            "security": "- Will apply baseline security (input validation, auth if applicable)",
        }
        return assumptions_map.get(key, "")

    def get_interactive_questions(self):
        """Generate questions for missing/partial dimensions."""
        questions = []
        for key, result in self.results.items():
            if result["confidence"] == "none":
                q = self._make_question(key)
                if q:
                    questions.append((key, q))
        return questions

    def _make_question(self, key):
        """Generate an interactive question for a missing dimension."""
        questions_map = {
            "feature_list": "No clear feature list found. Can you list the key features? (comma-separated): ",
            "tech_stack": "No tech stack specified. What technologies should be used? [e.g., React+Node, Python+FastAPI]: ",
            "user_stories": "No user stories found. Who are the primary users? (comma-separated roles): ",
            "acceptance_criteria": "No acceptance criteria found. What defines 'done' for this project?: ",
            "data_model": "No data model specified. Which database should be used? [postgres/mysql/sqlite/mongodb/none]: ",
            "api_spec": "No API specs found. Will this project have a REST API? [yes/no]: ",
            "deployment": "No deployment requirements. Where will this be deployed? [docker/vercel/aws/local]: ",
            "error_handling": "No error handling requirements. Any specific reliability needs? [skip to use defaults]: ",
            "security": "No security requirements. Does this need authentication? [yes/no/skip]: ",
        }
        return questions_map.get(key)

    def run_interactive(self):
        """Run interactive Q&A for missing dimensions. Returns clarifications dict."""
        if not sys.stdin.isatty():
            return {}

        questions = self.get_interactive_questions()
        if not questions:
            print("PRD covers all key dimensions. No questions needed.")
            return {}

        print(f"\nPRD Quality Score: {self.score}/10")
        print(f"Found {len(questions)} gap(s). Please provide clarifications:\n")

        clarifications = {}
        for key, question in questions:
            try:
                answer = input(question).strip()
                if answer and answer.lower() not in ("skip", ""):
                    clarifications[key] = answer
            except (EOFError, KeyboardInterrupt):
                print("\nInteractive mode cancelled.")
                break

        return clarifications

    def append_clarifications(self, observations_text, clarifications):
        """Append user clarifications to observations content."""
        if not clarifications:
            return observations_text

        lines = [observations_text.rstrip(), "", "## User Clarifications", ""]
        for key, answer in clarifications.items():
            label = DIMENSIONS[key]["label"] if key in DIMENSIONS else key
            lines.append(f"- **{label}**: {answer}")
        lines.append("")

        return "\n".join(lines)


def write_atomic(path, content):
    """Write content to file atomically using temp file + rename."""
    path = Path(path)
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


def main():
    parser = argparse.ArgumentParser(
        description="Analyze PRD quality and completeness for Loki Mode"
    )
    parser.add_argument("prd_path", help="Path to the PRD markdown file")
    parser.add_argument(
        "--output",
        default=".loki/prd-observations.md",
        help="Output path for observations (default: .loki/prd-observations.md)",
    )
    parser.add_argument(
        "--architecture",
        metavar="PATH",
        help="Optional architecture document to include in analysis",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Ask clarifying questions for missing dimensions",
    )
    args = parser.parse_args()

    try:
        analyzer = PrdAnalyzer(args.prd_path, architecture_path=args.architecture)
        analyzer.analyze()
        observations = analyzer.generate_observations()

        clarifications = {}
        if args.interactive:
            clarifications = analyzer.run_interactive()
            if clarifications:
                observations = analyzer.append_clarifications(observations, clarifications)

        write_atomic(args.output, observations)
        print(f"PRD analysis complete: score={analyzer.score}/10 scope={analyzer.scope}")
        print(f"Observations written to: {args.output}")

    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
