"""Multi-persona debate for component quality review.

Inspired by MoMoA (retomeier/MoMoA). Conflicting personas argue perspectives
on a generated component; their critique is fed into a final refinement pass.

Design:
- Round 1: Each persona reviews independently (parallel if provider supports)
- Round 2: Personas see each other's critiques and respond
- Round 3: Synthesizer produces final refined code incorporating valid critiques
- If any persona BLOCKS (severe issue), escalate to human-in-the-loop

Stdlib only: dataclasses, json, pathlib, subprocess, shutil, os, sys,
concurrent.futures, textwrap.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_PERSONAS = ["creative", "conservative", "a11y", "performance"]
VALID_SEVERITIES = ("info", "suggestion", "warning", "block")
VALID_TARGETS = ("react", "webcomponent")

# Provider invocation timeouts (seconds). Debate prompts are review-sized,
# not generation-sized, so we keep this shorter than the generator's.
DEFAULT_PROVIDER_TIMEOUT = 180

# Max characters of code/spec we inject into a single prompt. Keeps
# subprocess arg lists and model context usage bounded.
MAX_PROMPT_CODE_CHARS = 40000
MAX_PROMPT_SPEC_CHARS = 8000


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Critique:
    """Single persona's verdict on a component."""

    persona: str
    severity: str  # one of VALID_SEVERITIES
    issues: list = field(default_factory=list)
    suggestions: list = field(default_factory=list)
    approves: bool = False
    raw_response: str = ""
    parse_error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "persona": self.persona,
            "severity": self.severity,
            "issues": list(self.issues),
            "suggestions": list(self.suggestions),
            "approves": self.approves,
            "parse_error": self.parse_error,
        }


@dataclass
class DebateResult:
    """Result of a full multi-round debate."""

    rounds: int
    critiques: list  # List[Critique]
    refined_code: str
    consensus: bool
    blocks: list  # List[Critique] where severity == 'block'
    human_needed: bool

    def to_dict(self) -> dict:
        return {
            "rounds": self.rounds,
            "critiques": [c.to_dict() for c in self.critiques],
            "refined_code": self.refined_code,
            "consensus": self.consensus,
            "blocks": [c.to_dict() for c in self.blocks],
            "human_needed": self.human_needed,
        }


# ---------------------------------------------------------------------------
# Provider invocation errors
# ---------------------------------------------------------------------------

class DebateProviderError(RuntimeError):
    """Raised when a provider subprocess fails non-recoverably."""


# ---------------------------------------------------------------------------
# DebateRunner
# ---------------------------------------------------------------------------

class DebateRunner:
    """Runs a multi-persona debate against generated component code."""

    def __init__(
        self,
        provider: str = "claude",
        project_dir: str = ".",
        timeout: int = DEFAULT_PROVIDER_TIMEOUT,
        parallel: bool = True,
    ):
        self.provider = provider
        self.project_dir = Path(project_dir).resolve()
        self.timeout = timeout
        self.parallel = parallel
        self.personas_dir = self._find_personas_dir()

    # ---- Persona discovery / loading ----------------------------------

    def _find_personas_dir(self) -> Path:
        """Locate magic/debate/personas/ relative to script or installed path.

        Search order:
        1. Environment override: ``LOKI_DEBATE_PERSONAS_DIR``
        2. Sibling to this module: ``../debate/personas``
        3. Under the project directory: ``<project>/magic/debate/personas``
        4. Current working directory: ``./magic/debate/personas``
        """
        env_override = os.environ.get("LOKI_DEBATE_PERSONAS_DIR")
        candidates: list = []
        if env_override:
            candidates.append(Path(env_override))

        module_dir = Path(__file__).resolve().parent  # magic/core
        candidates.append(module_dir.parent / "debate" / "personas")
        candidates.append(self.project_dir / "magic" / "debate" / "personas")
        candidates.append(Path.cwd() / "magic" / "debate" / "personas")

        for candidate in candidates:
            if candidate.is_dir():
                return candidate

        # Fallback to the conventional location even if missing; loading will
        # fail later with a clear error.
        return module_dir.parent / "debate" / "personas"

    def load_persona(self, name: str) -> str:
        """Load a persona system prompt from a markdown file."""
        safe_name = Path(name).name  # prevent path traversal
        prompt_path = self.personas_dir / f"{safe_name}.md"
        if not prompt_path.is_file():
            raise FileNotFoundError(
                f"Persona '{name}' not found at {prompt_path}. "
                f"Available: {sorted(p.stem for p in self.personas_dir.glob('*.md'))}"
            )
        return prompt_path.read_text(encoding="utf-8")

    # ---- Public API ---------------------------------------------------

    def run_debate(
        self,
        component_code: str,
        spec: str,
        personas: Optional[list] = None,
        rounds: int = 3,
        target: str = "react",
    ) -> DebateResult:
        """Run the full debate and return a DebateResult.

        Args:
            component_code: The generated component source code.
            spec: The original spec the component was generated against.
            personas: List of persona names (default: all four).
            rounds: 1 = independent review only; 2 = add cross-critique;
                3 = add synthesis into refined code.
            target: 'react' or 'webcomponent' (affects synthesis prompt).
        """
        if target not in VALID_TARGETS:
            raise ValueError(
                f"target must be one of {VALID_TARGETS}, got {target!r}"
            )
        if rounds < 1:
            raise ValueError("rounds must be >= 1")

        personas = list(personas) if personas else list(DEFAULT_PERSONAS)

        # Round 1: independent review (parallel when supported).
        critiques = self._round_one(personas, component_code, spec, target)

        # Round 2: cross-critique.
        if rounds >= 2:
            critiques = self._round_two(
                personas, critiques, component_code, spec, target
            )

        # Round 3: synthesis.
        refined = component_code
        if rounds >= 3:
            refined = self._synthesize(component_code, critiques, spec, target)

        blocks = [c for c in critiques if c.severity == "block"]
        consensus = len(critiques) > 0 and all(c.approves for c in critiques)

        return DebateResult(
            rounds=rounds,
            critiques=critiques,
            refined_code=refined,
            consensus=consensus,
            blocks=blocks,
            human_needed=len(blocks) > 0,
        )

    # ---- Rounds -------------------------------------------------------

    def _round_one(
        self,
        personas: list,
        code: str,
        spec: str,
        target: str,
    ) -> list:
        """Round 1: each persona reviews independently."""
        if self.parallel and len(personas) > 1:
            results: dict = {}
            with ThreadPoolExecutor(max_workers=len(personas)) as pool:
                future_map = {
                    pool.submit(self._review, name, code, spec, target): name
                    for name in personas
                }
                for fut in as_completed(future_map):
                    name = future_map[fut]
                    try:
                        results[name] = fut.result()
                    except Exception as exc:  # keep the debate moving
                        results[name] = self._critique_from_error(name, exc)
            return [results[n] for n in personas]

        # Sequential path (degraded providers, or parallel disabled).
        critiques = []
        for name in personas:
            try:
                critiques.append(self._review(name, code, spec, target))
            except Exception as exc:
                critiques.append(self._critique_from_error(name, exc))
        return critiques

    def _round_two(
        self,
        personas: list,
        initial: list,
        code: str,
        spec: str,
        target: str,
    ) -> list:
        """Round 2: each persona responds after reading the others."""
        summary = self._summarize_critiques(initial)

        def _revise(idx: int, name: str) -> Critique:
            others = [c for j, c in enumerate(initial) if j != idx]
            others_text = self._summarize_critiques(others) or "(no other critiques)"
            return self._review(
                persona_name=name,
                code=code,
                spec=spec,
                target=target,
                prior_critiques_text=others_text,
                prior_self_critique=initial[idx],
                round_label="round-2",
            )

        if self.parallel and len(personas) > 1:
            results: dict = {}
            with ThreadPoolExecutor(max_workers=len(personas)) as pool:
                future_map = {
                    pool.submit(_revise, i, name): i
                    for i, name in enumerate(personas)
                }
                for fut in as_completed(future_map):
                    i = future_map[fut]
                    try:
                        results[i] = fut.result()
                    except Exception as exc:
                        results[i] = self._critique_from_error(personas[i], exc)
            # Preserve original persona ordering.
            return [results[i] for i in range(len(personas))]

        revised = []
        for i, name in enumerate(personas):
            try:
                revised.append(_revise(i, name))
            except Exception as exc:
                revised.append(self._critique_from_error(name, exc))
        # If summary was unused in the sequential path, keep it bound to
        # silence linters and signal intent.
        _ = summary
        return revised

    def _synthesize(
        self,
        code: str,
        critiques: list,
        spec: str,
        target: str,
    ) -> str:
        """Round 3: synthesize critiques into a refined component."""
        summary = self._summarize_critiques(critiques)
        target_note = (
            "React component (functional, hooks, TypeScript if already used)."
            if target == "react"
            else "Web Component (custom element extending HTMLElement, Shadow DOM if already used)."
        )
        prompt = textwrap.dedent(
            """
            You are a synthesizing editor. You have a generated component and
            four expert critiques from a creative developer, a conservative
            senior engineer, an accessibility advocate, and a performance
            engineer. Produce a refined version of the component that
            incorporates the VALID critiques.

            Rules:
            - Preserve the component's public API (props, exports) unless a
              critique calls out a breaking-change bug.
            - When critiques conflict, prefer: accessibility > correctness >
              performance > delight. Cite your reasoning in a short comment
              at the top of the file only if a meaningful trade-off was made.
            - Do not invent new dependencies. Only import from packages the
              original code already imports from.
            - Do not add TODO comments. Fix issues inline or leave them.
            - Output ONLY the final source code. No prose, no markdown fence,
              no explanation.

            TARGET: {target_note}

            SPEC:
            {spec}

            CRITIQUES:
            {summary}

            ORIGINAL CODE:
            {code}

            Return the refined code now.
            """
        ).strip().format(
            target_note=target_note,
            spec=self._truncate(spec, MAX_PROMPT_SPEC_CHARS),
            summary=summary or "(no critiques)",
            code=self._truncate(code, MAX_PROMPT_CODE_CHARS),
        )

        try:
            response = self._invoke_provider(prompt)
        except DebateProviderError:
            # Synthesis failure is non-fatal; fall back to original code.
            return code

        return self._strip_code_fences(response).strip() or code

    # ---- Single-persona review ----------------------------------------

    def _review(
        self,
        persona_name: str,
        code: str,
        spec: str,
        target: str,
        prior_critiques_text: str = "",
        prior_self_critique: Optional[Critique] = None,
        round_label: str = "round-1",
    ) -> Critique:
        """Invoke one persona and parse its critique."""
        persona_prompt = self.load_persona(persona_name)
        target_note = (
            "The component is a React functional component."
            if target == "react"
            else "The component is a Web Component (custom element)."
        )

        prior_block = ""
        if prior_critiques_text:
            prior_block = (
                "\n\nOTHER REVIEWERS SAID (use this to refine or defend your "
                "position; do not repeat their points unless you agree):\n"
                f"{prior_critiques_text}"
            )
        if prior_self_critique is not None:
            prior_block += (
                "\n\nYOUR EARLIER CRITIQUE (you may escalate, soften, or "
                "retract items in light of the discussion):\n"
                f"{self._format_single_critique(prior_self_critique)}"
            )

        full_prompt = textwrap.dedent(
            """
            {persona_prompt}

            ---

            REVIEW ROUND: {round_label}
            {target_note}

            SPEC:
            {spec}

            CODE TO REVIEW:
            {code}
            {prior_block}

            Respond with a SINGLE JSON object and nothing else. The JSON must
            have exactly these keys: "severity", "issues", "suggestions",
            "approves". "severity" must be one of: "info", "suggestion",
            "warning", "block". "issues" and "suggestions" must be arrays of
            short strings (each a concrete, specific item). "approves" must be
            a boolean. Do not wrap the JSON in markdown fences.
            """
        ).strip().format(
            persona_prompt=persona_prompt,
            round_label=round_label,
            target_note=target_note,
            spec=self._truncate(spec, MAX_PROMPT_SPEC_CHARS),
            code=self._truncate(code, MAX_PROMPT_CODE_CHARS),
            prior_block=prior_block,
        )

        response = self._invoke_provider(full_prompt)
        return self._parse_critique(persona_name, response)

    # ---- Provider invocation ------------------------------------------

    def _invoke_provider(self, prompt: str) -> str:
        """Invoke the configured provider CLI and return stdout.

        Mirrors the subprocess pattern used by ComponentGenerator: each
        provider has its own flag layout for autonomous + prompt input.
        """
        cmd = self._build_command(prompt)
        cli = cmd[0]
        if shutil.which(cli) is None:
            raise DebateProviderError(
                f"Provider CLI '{cli}' not found on PATH. "
                f"Install it or pick a different provider."
            )

        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
                cwd=str(self.project_dir),
            )
        except subprocess.TimeoutExpired as exc:
            raise DebateProviderError(
                f"Provider '{self.provider}' timed out after {self.timeout}s"
            ) from exc
        except OSError as exc:
            raise DebateProviderError(
                f"Failed to spawn provider '{self.provider}': {exc}"
            ) from exc

        if completed.returncode != 0:
            stderr = (completed.stderr or "").strip()
            raise DebateProviderError(
                f"Provider '{self.provider}' exited with code "
                f"{completed.returncode}: {stderr[:400]}"
            )

        return completed.stdout or ""

    def _build_command(self, prompt: str) -> list:
        """Map self.provider to an argv list."""
        provider = self.provider.lower()
        if provider == "claude":
            return ["claude", "--dangerously-skip-permissions", "-p", prompt]
        if provider == "codex":
            # Codex uses `exec --full-auto` with the prompt as positional.
            return ["codex", "exec", "--full-auto", prompt]
        if provider == "gemini":
            return ["gemini", "--approval-mode=yolo", prompt]
        if provider == "cline":
            return ["cline", "--auto", "-p", prompt]
        if provider == "aider":
            return ["aider", "--yes", "--message", prompt]
        raise DebateProviderError(f"Unknown provider: {self.provider!r}")

    # ---- Parsing ------------------------------------------------------

    def _parse_critique(self, persona: str, response: str) -> Critique:
        """Parse a provider response into a Critique.

        Handles: fenced JSON, stray prose around JSON, and malformed JSON.
        Always returns a Critique -- parse errors are recorded but never
        raised so the debate can proceed.
        """
        raw = response or ""
        payload = self._extract_json(raw)

        if payload is None:
            return Critique(
                persona=persona,
                severity="info",
                issues=[],
                suggestions=[],
                approves=True,
                raw_response=raw,
                parse_error="no JSON object found in response",
            )

        severity = str(payload.get("severity", "info")).strip().lower()
        if severity not in VALID_SEVERITIES:
            severity = "info"

        issues = self._coerce_string_list(payload.get("issues"))
        suggestions = self._coerce_string_list(payload.get("suggestions"))

        approves_raw = payload.get("approves")
        if isinstance(approves_raw, bool):
            approves = approves_raw
        elif isinstance(approves_raw, str):
            approves = approves_raw.strip().lower() in ("true", "yes", "1")
        else:
            # If the model omitted approves, infer from severity.
            approves = severity in ("info", "suggestion")

        # Safety: a blocking severity can never be approved.
        if severity == "block":
            approves = False

        return Critique(
            persona=persona,
            severity=severity,
            issues=issues,
            suggestions=suggestions,
            approves=approves,
            raw_response=raw,
        )

    @staticmethod
    def _extract_json(text: str) -> Optional[dict]:
        """Extract the first top-level JSON object from text.

        Tries: direct parse, fenced block parse, brace-balanced scan.
        """
        stripped = text.strip()
        if not stripped:
            return None

        # Direct parse first.
        try:
            value = json.loads(stripped)
            return value if isinstance(value, dict) else None
        except json.JSONDecodeError:
            pass

        # Strip common markdown fences and retry.
        fenced = DebateRunner._strip_code_fences(stripped)
        if fenced != stripped:
            try:
                value = json.loads(fenced)
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                pass

        # Brace-balanced scan to find an embedded object.
        start = stripped.find("{")
        while start != -1:
            depth = 0
            in_string = False
            escape = False
            for i in range(start, len(stripped)):
                ch = stripped[i]
                if escape:
                    escape = False
                    continue
                if ch == "\\" and in_string:
                    escape = True
                    continue
                if ch == '"':
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = stripped[start : i + 1]
                        try:
                            value = json.loads(candidate)
                            if isinstance(value, dict):
                                return value
                        except json.JSONDecodeError:
                            break  # try next opening brace
                        break
            start = stripped.find("{", start + 1)

        return None

    @staticmethod
    def _coerce_string_list(value) -> list:
        if value is None:
            return []
        if isinstance(value, str):
            cleaned = value.strip()
            return [cleaned] if cleaned else []
        if isinstance(value, list):
            out = []
            for item in value:
                if isinstance(item, str):
                    s = item.strip()
                    if s:
                        out.append(s)
                elif isinstance(item, dict):
                    # Gracefully flatten {"issue": "..."} style entries.
                    for key in ("issue", "suggestion", "text", "message"):
                        if key in item and isinstance(item[key], str):
                            s = item[key].strip()
                            if s:
                                out.append(s)
                            break
                    else:
                        out.append(json.dumps(item, ensure_ascii=False))
            return out
        return [str(value)]

    @staticmethod
    def _strip_code_fences(text: str) -> str:
        """Strip leading/trailing markdown code fences, if any."""
        s = text.strip()
        if not s.startswith("```"):
            return s
        # Drop the first fence line (optionally with language tag).
        first_newline = s.find("\n")
        if first_newline == -1:
            return s
        body = s[first_newline + 1 :]
        if body.rstrip().endswith("```"):
            body = body.rstrip()[:-3]
        return body.rstrip()

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        if text is None:
            return ""
        if len(text) <= limit:
            return text
        return text[:limit] + f"\n... [truncated at {limit} chars]"

    # ---- Formatting helpers -------------------------------------------

    @staticmethod
    def _format_single_critique(c: Critique) -> str:
        issues = "\n".join(f"    - {i}" for i in c.issues) or "    (none)"
        suggestions = (
            "\n".join(f"    - {s}" for s in c.suggestions) or "    (none)"
        )
        approves = "yes" if c.approves else "no"
        return (
            f"[{c.persona}] severity={c.severity} approves={approves}\n"
            f"  issues:\n{issues}\n"
            f"  suggestions:\n{suggestions}"
        )

    def _summarize_critiques(self, critiques: Iterable[Critique]) -> str:
        parts = [self._format_single_critique(c) for c in critiques]
        return "\n\n".join(parts)

    @staticmethod
    def _critique_from_error(persona: str, exc: Exception) -> Critique:
        """Build a fail-safe Critique when a persona invocation errors.

        The debate must continue even if one persona goes down. We mark
        these as neutral ('info', approves=True) so they do not spuriously
        block consensus; the underlying error is preserved in parse_error.
        """
        return Critique(
            persona=persona,
            severity="info",
            issues=[],
            suggestions=[],
            approves=True,
            raw_response="",
            parse_error=f"{type(exc).__name__}: {exc}",
        )


# ---------------------------------------------------------------------------
# CLI entry point (optional convenience)
# ---------------------------------------------------------------------------

def _main(argv: list) -> int:
    """Minimal CLI for manual smoke-testing: ``python -m magic.core.debate``.

    Reads code from --code-file, spec from --spec-file, prints the
    DebateResult as JSON. Not intended as the primary interface; the
    Python API is the supported contract.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Run a multi-persona debate.")
    parser.add_argument("--code-file", required=True)
    parser.add_argument("--spec-file", required=True)
    parser.add_argument("--provider", default="claude")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--target", default="react", choices=list(VALID_TARGETS))
    parser.add_argument("--personas", nargs="*", default=None)
    parser.add_argument("--no-parallel", action="store_true")
    parser.add_argument("--project-dir", default=".")
    args = parser.parse_args(argv)

    code = Path(args.code_file).read_text(encoding="utf-8")
    spec = Path(args.spec_file).read_text(encoding="utf-8")

    runner = DebateRunner(
        provider=args.provider,
        project_dir=args.project_dir,
        parallel=not args.no_parallel,
    )
    result = runner.run_debate(
        component_code=code,
        spec=spec,
        personas=args.personas,
        rounds=args.rounds,
        target=args.target,
    )
    sys.stdout.write(json.dumps(result.to_dict(), indent=2) + "\n")
    return 0 if not result.human_needed else 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))


# ---------------------------------------------------------------------------
# Module-level convenience API (called by autonomy/loki cmd_magic)
# ---------------------------------------------------------------------------

def run_debate(
    name: str,
    spec_path: str = "",
    component_path: str = "",
    rounds: int = 3,
    personas: list = None,
    target: str = "react",
    project_dir: str = ".",
) -> dict:
    """Run a multi-persona debate and return the result as a dict."""
    from pathlib import Path as _P
    spec = _P(spec_path).read_text() if spec_path and _P(spec_path).exists() else ""
    code = _P(component_path).read_text() if component_path and _P(component_path).exists() else ""
    runner = DebateRunner(project_dir=project_dir)
    result = runner.run_debate(
        component_code=code,
        spec=spec,
        personas=personas,
        rounds=rounds,
        target=target,
    )
    try:
        from dataclasses import asdict as _asdict
        return {
            "rounds": result.rounds,
            "consensus": result.consensus,
            "human_needed": result.human_needed,
            "critiques": [_asdict(c) for c in result.critiques],
            "refined_code": result.refined_code,
            "blocks": [_asdict(b) for b in result.blocks],
        }
    except Exception as exc:
        return {"error": str(exc)}
