"""Unified component generator for React and Web Component variants.

Takes a markdown spec plus optional design tokens and produces a component
in either of two targets:

    - React + TypeScript (functional component, Tailwind classes)
    - Web Component extending LokiElement (Shadow DOM, scoped styles)

Inspired by MagicModules (Roman Nurik) React engine, adapted to Loki
Mode's provider abstraction so the same spec works with claude, codex,
gemini, cline, or aider.

Rules followed by this module:

    - Standard library only (subprocess, pathlib, json, hashlib, base64,
      os, shutil, re, typing).
    - No emojis anywhere in prompts or generated scaffolds.
    - Graceful degradation: when the provider CLI is unavailable or
      fails, fall back to a deterministic template scaffold so callers
      always receive usable code.
    - SHA256 hash header is embedded in every artifact so callers can
      detect when spec/token inputs change and regenerate.

The provider invocation pattern mirrors _docs_invoke_provider() in
autonomy/loki (line 18487): honor LOKI_PROVIDER, prefer timeout or
gtimeout when available, return an empty string on failure so the
caller may fall back to a template.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional


# Providers supported by the Loki Mode runtime. Any value outside this
# set is treated as claude to stay safe.
_SUPPORTED_PROVIDERS = {"claude", "codex", "gemini", "cline", "aider"}

# Default timeout in seconds for a single provider invocation. Matches
# the 120s used by the shell _docs_invoke_provider helper.
_DEFAULT_TIMEOUT_SECONDS = 120


class ComponentGenerator:
    """Spec-driven generator for React and Web Component artifacts."""

    def __init__(self, provider: str = "claude", project_dir: str = ".") -> None:
        resolved_provider = (provider or "claude").strip().lower()
        if resolved_provider not in _SUPPORTED_PROVIDERS:
            resolved_provider = "claude"
        self.provider: str = resolved_provider
        self.project_dir: Path = Path(project_dir).resolve()
        self.timeout_seconds: int = _DEFAULT_TIMEOUT_SECONDS

    # -----------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------

    def generate_react(
        self,
        spec: str,
        name: str,
        design_tokens: Optional[Dict] = None,
    ) -> str:
        """Generate a React + TypeScript component from a markdown spec.

        The returned component:
            - Uses TypeScript with a proper Props interface.
            - Applies design tokens via Tailwind CSS classes.
            - Includes accessibility attributes (aria-*, role).
            - Starts with a SHA256 hash header for freshness checking.
        """
        safe_name = _sanitize_component_name(name)
        tokens = design_tokens or {}
        prompt = self._build_react_prompt(spec, safe_name, tokens)
        body = self._invoke_provider(prompt)
        if not body.strip():
            body = _fallback_react_component(safe_name, spec, tokens)
        cleaned = _strip_markdown_fences(body)
        header = _hash_header("react", safe_name, spec, tokens)
        return f"{header}\n{cleaned.rstrip()}\n"

    def generate_webcomponent(
        self,
        spec: str,
        name: str,
        design_tokens: Optional[Dict] = None,
    ) -> str:
        """Generate a Web Component (loki-* custom element) from a spec.

        The component:
            - Extends the LokiElement base class used by dashboard-ui.
            - Uses Shadow DOM with scoped styles.
            - Consumes CSS custom properties sourced from design tokens.
            - Starts with a SHA256 hash header for freshness checking.
        """
        safe_name = _sanitize_component_name(name)
        tokens = design_tokens or {}
        prompt = self._build_webcomponent_prompt(spec, safe_name, tokens)
        body = self._invoke_provider(prompt)
        if not body.strip():
            body = _fallback_webcomponent(safe_name, spec, tokens)
        cleaned = _strip_markdown_fences(body)
        header = _hash_header("webcomponent", safe_name, spec, tokens)
        return f"{header}\n{cleaned.rstrip()}\n"

    def generate_test(self, component_code: str, name: str, target: str) -> str:
        """Generate a test skeleton for the given component.

        Vitest is used for React targets and Playwright for web-component
        targets. Callers may pass 'react' or 'webcomponent' as target.
        """
        safe_name = _sanitize_component_name(name)
        resolved_target = (target or "react").strip().lower()
        if resolved_target not in {"react", "webcomponent"}:
            resolved_target = "react"
        prompt = self._build_test_prompt(component_code, safe_name, resolved_target)
        body = self._invoke_provider(prompt)
        if not body.strip():
            body = _fallback_test(safe_name, resolved_target)
        cleaned = _strip_markdown_fences(body)
        header = _hash_header(f"test-{resolved_target}", safe_name, component_code, {})
        return f"{header}\n{cleaned.rstrip()}\n"

    def generate_from_screenshot(self, image_path: str, name: str) -> str:
        """Analyze a screenshot and produce a markdown spec.

        When the Claude CLI supports vision input the screenshot is sent
        as a base64 data URL. Otherwise a deterministic template spec is
        returned so downstream generators still have a starting point.
        """
        safe_name = _sanitize_component_name(name)
        resolved_path = Path(image_path).expanduser()
        if not resolved_path.is_file():
            return _fallback_spec(safe_name, f"screenshot {image_path} not found")

        encoded = _encode_image(resolved_path)
        if not encoded:
            return _fallback_spec(safe_name, "screenshot could not be encoded")

        prompt = self._build_vision_prompt(safe_name, resolved_path, encoded)
        body = self._invoke_provider(prompt)
        if not body.strip():
            return _fallback_spec(safe_name, f"analyzed screenshot at {resolved_path}")
        return _strip_markdown_fences(body).rstrip() + "\n"

    # -----------------------------------------------------------------
    # Provider invocation
    # -----------------------------------------------------------------

    def _invoke_provider(self, prompt: str) -> str:
        """Call the selected provider CLI with the given prompt.

        Mirrors the behavior of autonomy/loki _docs_invoke_provider():
        honors LOKI_PROVIDER, uses timeout or gtimeout when available,
        and returns the empty string on any error so the caller can
        fall back to a template.
        """
        provider = os.environ.get("LOKI_PROVIDER", self.provider).strip().lower()
        if provider not in _SUPPORTED_PROVIDERS:
            provider = self.provider

        binary = shutil.which(provider)
        if not binary:
            return ""

        timeout_bin = shutil.which("timeout") or shutil.which("gtimeout") or ""
        base_cmd: List[str] = []
        if timeout_bin:
            base_cmd.extend([timeout_bin, str(self.timeout_seconds)])

        if provider == "claude":
            cmd = base_cmd + [binary, "-p", prompt]
        elif provider == "codex":
            cmd = base_cmd + [binary, "exec", "--full-auto", prompt]
        elif provider == "gemini":
            cmd = base_cmd + [binary, "--approval-mode=yolo", prompt]
        elif provider == "cline":
            cmd = base_cmd + [binary, "-y", prompt]
        elif provider == "aider":
            cmd = base_cmd + [
                binary,
                "--message",
                prompt,
                "--yes-always",
                "--no-auto-commits",
            ]
        else:
            return ""

        try:
            completed = subprocess.run(
                cmd,
                cwd=str(self.project_dir),
                input="" if provider == "aider" else None,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds + 5,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            return ""

        if completed.returncode != 0 and not completed.stdout:
            return ""

        return completed.stdout or ""

    # -----------------------------------------------------------------
    # Prompt builders
    # -----------------------------------------------------------------

    def _build_react_prompt(self, spec: str, name: str, tokens: Dict) -> str:
        tokens_summary = _summarize_tokens(tokens)
        example = (
            "import * as React from 'react';\n"
            f"export interface {name}Props {{ label: string; onAction?: () => void; }}\n"
            f"export function {name}(props: {name}Props) {{\n"
            "  return (\n"
            "    <button\n"
            "      type=\"button\"\n"
            "      aria-label={props.label}\n"
            "      className=\"px-4 py-2 rounded-md bg-[--loki-accent] text-white\"\n"
            "      onClick={props.onAction}\n"
            "    >\n"
            "      {props.label}\n"
            "    </button>\n"
            "  );\n"
            "}\n"
        )
        return (
            "You are an expert React + TypeScript component author.\n"
            "\n"
            "Hard rules (must all hold):\n"
            "  - Output pure TypeScript/TSX source code for a single React\n"
            "    functional component.\n"
            "  - NO emojis anywhere (code, comments, strings, JSX text).\n"
            "  - Declare an exported Props interface named <Name>Props with\n"
            "    precise, non-any types.\n"
            "  - Style with Tailwind CSS utility classes only. Reference\n"
            "    design tokens via Tailwind arbitrary values such as\n"
            "    `bg-[--loki-accent]` or `text-[--loki-text-primary]`.\n"
            "  - Include accessibility attributes (aria-*, role) that fit\n"
            "    the component's semantics.\n"
            "  - Use only React imports (no external UI libraries).\n"
            "  - Output just the source code. No markdown fences, no prose,\n"
            "    no explanation before or after.\n"
            "\n"
            f"Component name: {name}\n"
            "\n"
            "Design tokens (CSS custom properties available):\n"
            f"{tokens_summary}\n"
            "\n"
            "Specification (markdown):\n"
            "---\n"
            f"{spec.strip()}\n"
            "---\n"
            "\n"
            "Example of the expected output shape (structure only, do not\n"
            "copy verbatim):\n"
            "---\n"
            f"{example}"
            "---\n"
            "\n"
            f"Now emit the {name} component source."
        )

    def _build_webcomponent_prompt(self, spec: str, name: str, tokens: Dict) -> str:
        tokens_summary = _summarize_tokens(tokens)
        tag = _kebab_case(name)
        if not tag.startswith("loki-"):
            tag = f"loki-{tag}"
        example = (
            "import { LokiElement } from '../core/loki-element.js';\n"
            f"export class {name} extends LokiElement {{\n"
            "  static get observedAttributes() { return ['label']; }\n"
            "  connectedCallback() { this.render(); }\n"
            "  attributeChangedCallback() { this.render(); }\n"
            "  render() {\n"
            "    const label = this.getAttribute('label') || '';\n"
            "    this.shadowRoot.innerHTML = `\n"
            "      <style>\n"
            "        :host { display: inline-block; }\n"
            "        .btn { background: var(--loki-accent); color: #fff;\n"
            "               padding: 0.5rem 1rem; border-radius: 0.375rem; }\n"
            "      </style>\n"
            "      <button class=\"btn\" aria-label=\"${label}\">${label}</button>\n"
            "    `;\n"
            "  }\n"
            "}\n"
            f"customElements.define('{tag}', {name});\n"
        )
        return (
            "You are an expert Web Components author working in the Loki\n"
            "Mode dashboard-ui codebase.\n"
            "\n"
            "Hard rules (must all hold):\n"
            "  - Output pure JavaScript source for a single custom element\n"
            "    class that extends LokiElement.\n"
            "  - NO emojis anywhere (code, comments, strings, template\n"
            "    literals).\n"
            "  - Import LokiElement from '../core/loki-element.js'.\n"
            "  - Attach a Shadow DOM with scoped <style> and render via\n"
            "    this.shadowRoot.innerHTML.\n"
            "  - Style exclusively with CSS custom properties declared in\n"
            "    the design tokens. Example: var(--loki-accent).\n"
            "  - Include accessibility attributes (aria-*, role) on\n"
            "    interactive elements.\n"
            f"  - Register the element as '{tag}' via customElements.define.\n"
            "  - Output just the source code. No markdown fences, no prose,\n"
            "    no explanation before or after.\n"
            "\n"
            f"Class name: {name}\n"
            f"Custom element tag: {tag}\n"
            "\n"
            "Design tokens (CSS custom properties available):\n"
            f"{tokens_summary}\n"
            "\n"
            "Specification (markdown):\n"
            "---\n"
            f"{spec.strip()}\n"
            "---\n"
            "\n"
            "Example of the expected output shape (structure only, do not\n"
            "copy verbatim):\n"
            "---\n"
            f"{example}"
            "---\n"
            "\n"
            f"Now emit the {name} custom element source."
        )

    def _build_test_prompt(self, component_code: str, name: str, target: str) -> str:
        if target == "webcomponent":
            runner = "Playwright"
            example = (
                "import { test, expect } from '@playwright/test';\n"
                f"test('{name} renders', async ({{ page }}) => {{\n"
                "  await page.goto('/fixtures/component.html');\n"
                f"  const el = page.locator('{_kebab_case(name)}');\n"
                "  await expect(el).toBeVisible();\n"
                "});\n"
            )
        else:
            runner = "Vitest with @testing-library/react"
            example = (
                "import { describe, it, expect } from 'vitest';\n"
                "import { render, screen } from '@testing-library/react';\n"
                f"import {{ {name} }} from './{name}';\n"
                f"describe('{name}', () => {{\n"
                "  it('renders label', () => {\n"
                f"    render(<{name} label=\"Go\" />);\n"
                "    expect(screen.getByText('Go')).toBeInTheDocument();\n"
                "  });\n"
                "});\n"
            )
        return (
            f"You are an expert test author. Produce a {runner} test\n"
            f"skeleton for the component named {name}.\n"
            "\n"
            "Hard rules:\n"
            "  - Output just the test source. No markdown fences, no\n"
            "    explanation, no emojis.\n"
            "  - Cover a rendering smoke test and one behavior assertion.\n"
            "  - Use plain, non-flaky selectors (role, label, tag name).\n"
            "\n"
            "Component source under test:\n"
            "---\n"
            f"{component_code.strip()}\n"
            "---\n"
            "\n"
            "Expected output shape (structure only):\n"
            "---\n"
            f"{example}"
            "---\n"
            "\n"
            f"Now emit the test file for {name}."
        )

    def _build_vision_prompt(self, name: str, image_path: Path, encoded: str) -> str:
        mime = _guess_mime(image_path)
        return (
            "You are an expert UI analyst. Inspect the attached screenshot\n"
            "and emit a concise markdown specification describing the\n"
            "component so it can be regenerated in code.\n"
            "\n"
            "Hard rules:\n"
            "  - Output markdown only. No emojis.\n"
            "  - Include sections: Structure, Layout, Colors, Typography,\n"
            "    States, Accessibility.\n"
            "  - Use color hex codes where visible.\n"
            "  - Keep the spec under 80 lines.\n"
            "\n"
            f"Component name: {name}\n"
            f"Screenshot path: {image_path}\n"
            f"Screenshot (base64 {mime}):\n"
            f"{encoded}\n"
            "\n"
            f"Now emit the markdown spec for {name}."
        )


# ---------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------


def _sanitize_component_name(name: str) -> str:
    """Coerce an arbitrary string to a PascalCase identifier."""
    if not name:
        return "Component"
    parts = re.split(r"[^0-9A-Za-z]+", name)
    pascal = "".join(part[:1].upper() + part[1:] for part in parts if part)
    if not pascal:
        return "Component"
    if pascal[0].isdigit():
        pascal = f"C{pascal}"
    return pascal


def _kebab_case(name: str) -> str:
    """Convert PascalCase or camelCase to kebab-case."""
    step1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1-\2", name)
    step2 = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", step1)
    return step2.lower().strip("-")


def _summarize_tokens(tokens: Dict) -> str:
    """Render the design token dict as a compact deterministic summary."""
    if not tokens:
        return "  (none provided; use sensible defaults)"
    try:
        flat: List[str] = []
        for key, value in sorted(tokens.items()):
            if isinstance(value, dict):
                nested = ", ".join(
                    f"{inner_key}={inner_val}"
                    for inner_key, inner_val in sorted(value.items())
                )
                flat.append(f"  {key}: {nested}")
            else:
                flat.append(f"  {key}: {value}")
        return "\n".join(flat) if flat else "  (empty)"
    except Exception:
        return "  (tokens unavailable)"


def _hash_header(kind: str, name: str, spec: str, tokens: Dict) -> str:
    """Build a SHA256 freshness header for a generated artifact."""
    payload = json.dumps(
        {"kind": kind, "name": name, "spec": spec, "tokens": tokens},
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    return (
        f"// loki-magic: kind={kind} name={name} sha256={digest}\n"
        "// Generated by magic/core/generator.py. Regenerate when the\n"
        "// spec or design tokens change; the hash above detects drift."
    )


def _strip_markdown_fences(text: str) -> str:
    """Remove surrounding triple-backtick fences if a provider added them."""
    stripped = text.strip()
    if stripped.startswith("```"):
        first_newline = stripped.find("\n")
        if first_newline != -1:
            stripped = stripped[first_newline + 1 :]
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[: -3].rstrip()
    return stripped


def _encode_image(path: Path) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return base64.b64encode(data).decode("ascii")


def _guess_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".gif":
        return "image/gif"
    return "image/png"


# ---------------------------------------------------------------------
# Deterministic fallbacks (used when no provider is available)
# ---------------------------------------------------------------------


def _fallback_react_component(name: str, spec: str, tokens: Dict) -> str:
    description = _first_line(spec) or f"{name} component"
    return (
        "import * as React from 'react';\n"
        "\n"
        f"export interface {name}Props {{\n"
        "  label: string;\n"
        "  onAction?: () => void;\n"
        "  className?: string;\n"
        "}\n"
        "\n"
        f"// {description}\n"
        f"export function {name}(props: {name}Props): JSX.Element {{\n"
        "  const { label, onAction, className } = props;\n"
        "  return (\n"
        "    <button\n"
        "      type=\"button\"\n"
        "      role=\"button\"\n"
        "      aria-label={label}\n"
        "      onClick={onAction}\n"
        "      className={[\n"
        "        'inline-flex items-center justify-center',\n"
        "        'px-4 py-2 rounded-md text-sm font-medium',\n"
        "        'bg-[--loki-accent] text-white',\n"
        "        'hover:bg-[--loki-accent-light]',\n"
        "        className || ''\n"
        "      ].join(' ')}\n"
        "    >\n"
        "      {label}\n"
        "    </button>\n"
        "  );\n"
        "}\n"
        "\n"
        f"export default {name};\n"
    )


def _fallback_webcomponent(name: str, spec: str, tokens: Dict) -> str:
    description = _first_line(spec) or f"{name} custom element"
    tag = _kebab_case(name)
    if not tag.startswith("loki-"):
        tag = f"loki-{tag}"
    return (
        "import { LokiElement } from '../core/loki-element.js';\n"
        "\n"
        f"// {description}\n"
        f"export class {name} extends LokiElement {{\n"
        "  static get observedAttributes() {\n"
        "    return ['label'];\n"
        "  }\n"
        "\n"
        "  connectedCallback() {\n"
        "    this.render();\n"
        "  }\n"
        "\n"
        "  attributeChangedCallback() {\n"
        "    this.render();\n"
        "  }\n"
        "\n"
        "  render() {\n"
        "    const label = this.getAttribute('label') || '';\n"
        "    this.shadowRoot.innerHTML = `\n"
        "      <style>\n"
        "        :host { display: inline-block; }\n"
        "        .btn {\n"
        "          display: inline-flex;\n"
        "          align-items: center;\n"
        "          justify-content: center;\n"
        "          padding: 0.5rem 1rem;\n"
        "          border-radius: 0.375rem;\n"
        "          font-size: 0.875rem;\n"
        "          font-weight: 500;\n"
        "          color: #ffffff;\n"
        "          background: var(--loki-accent, #553DE9);\n"
        "          border: none;\n"
        "          cursor: pointer;\n"
        "        }\n"
        "        .btn:hover { background: var(--loki-accent-light, #7B6BF0); }\n"
        "      </style>\n"
        "      <button class=\"btn\" type=\"button\" role=\"button\" aria-label=\"${label}\">\n"
        "        ${label}\n"
        "      </button>\n"
        "    `;\n"
        "  }\n"
        "}\n"
        "\n"
        f"if (!customElements.get('{tag}')) {{\n"
        f"  customElements.define('{tag}', {name});\n"
        "}\n"
    )


def _fallback_test(name: str, target: str) -> str:
    if target == "webcomponent":
        tag = _kebab_case(name)
        if not tag.startswith("loki-"):
            tag = f"loki-{tag}"
        return (
            "import { test, expect } from '@playwright/test';\n"
            "\n"
            f"test('{name} renders and is accessible', async ({{ page }}) => {{\n"
            "  await page.goto('/fixtures/component.html');\n"
            f"  const el = page.locator('{tag}');\n"
            "  await expect(el).toBeVisible();\n"
            "  const label = await el.getAttribute('label');\n"
            "  if (label) {\n"
            "    await expect(el).toHaveAttribute('label', label);\n"
            "  }\n"
            "});\n"
        )
    return (
        "import { describe, it, expect, vi } from 'vitest';\n"
        "import { render, screen, fireEvent } from '@testing-library/react';\n"
        f"import {{ {name} }} from './{name}';\n"
        "\n"
        f"describe('{name}', () => {{\n"
        "  it('renders the provided label', () => {\n"
        f"    render(<{name} label=\"Go\" />);\n"
        "    expect(screen.getByText('Go')).toBeInTheDocument();\n"
        "  });\n"
        "\n"
        "  it('invokes onAction when clicked', () => {\n"
        "    const handler = vi.fn();\n"
        f"    render(<{name} label=\"Go\" onAction={{handler}} />);\n"
        "    fireEvent.click(screen.getByText('Go'));\n"
        "    expect(handler).toHaveBeenCalledTimes(1);\n"
        "  });\n"
        "});\n"
    )


def _fallback_spec(name: str, note: str) -> str:
    return (
        f"# {name} Specification\n"
        "\n"
        "## Structure\n"
        f"- Root element for {name}.\n"
        "- Primary interactive control with label text.\n"
        "\n"
        "## Layout\n"
        "- Inline-block container, centered content, comfortable padding.\n"
        "\n"
        "## Colors\n"
        "- Background: var(--loki-accent).\n"
        "- Foreground: #FFFFFF.\n"
        "\n"
        "## Typography\n"
        "- System sans-serif, 14px, medium weight.\n"
        "\n"
        "## States\n"
        "- Default, hover (accent-light), focus (visible outline), disabled.\n"
        "\n"
        "## Accessibility\n"
        "- role=button, aria-label mirrors the visible label.\n"
        "\n"
        f"Note: {note}\n"
    )


def _first_line(text: str) -> str:
    if not text:
        return ""
    for line in text.splitlines():
        trimmed = line.strip().lstrip("#").strip()
        if trimmed:
            return trimmed
    return ""


# ---------------------------------------------------------------------------
# Module-level convenience API (called by autonomy/loki cmd_magic)
# ---------------------------------------------------------------------------

def generate_component(
    name: str,
    spec_path: str,
    target: str = "react",
    react_out: str = "",
    wc_out: str = "",
    test_out: str = "",
    placement=None,
    project_dir: str = ".",
) -> dict:
    """Generate component variants from a spec file and write them to disk.

    Returns a dict with the paths actually written and their SHA256 hashes.
    """
    from pathlib import Path as _P
    spec_text = _P(spec_path).read_text() if _P(spec_path).exists() else ""
    gen = ComponentGenerator(project_dir=project_dir)
    tokens = None
    try:
        from magic.core.design_tokens import DesignTokens
        tokens = DesignTokens(project_dir).tokens
    except Exception:
        tokens = None

    written = {}
    targets = {"react", "webcomponent"} if target == "both" else {target}

    if "react" in targets and react_out:
        code = gen.generate_react(spec_text, name, tokens)
        _P(react_out).parent.mkdir(parents=True, exist_ok=True)
        _P(react_out).write_text(code)
        written["react"] = react_out
    if "webcomponent" in targets and wc_out:
        code = gen.generate_webcomponent(spec_text, name, tokens)
        _P(wc_out).parent.mkdir(parents=True, exist_ok=True)
        _P(wc_out).write_text(code)
        written["webcomponent"] = wc_out
    if test_out and "react" in written:
        try:
            test_code = gen.generate_test(open(written["react"]).read(), name, "react")
            _P(test_out).parent.mkdir(parents=True, exist_ok=True)
            _P(test_out).write_text(test_code)
            written["test"] = test_out
        except Exception:
            pass
    return written


def update_components(name: str = "", force: bool = False, project_dir: str = ".") -> list:
    """Re-run generate_component for any spec whose generated output is stale."""
    from pathlib import Path as _P
    from magic.core.freshness import needs_regen
    specs_dir = _P(project_dir) / ".loki" / "magic" / "specs"
    gen_dir = _P(project_dir) / ".loki" / "magic" / "generated"
    updated = []
    for spec_path in specs_dir.glob("*.md"):
        cname = spec_path.stem
        if name and cname != name:
            continue
        react_out = gen_dir / "react" / f"{cname}.tsx"
        wc_out = gen_dir / "webcomponent" / f"{cname}.js"
        if force or needs_regen(spec_path, react_out) or needs_regen(spec_path, wc_out):
            generate_component(
                name=cname,
                spec_path=str(spec_path),
                target="both",
                react_out=str(react_out),
                wc_out=str(wc_out),
                test_out=str(gen_dir / "tests" / f"{cname}.test.tsx"),
                project_dir=project_dir,
            )
            updated.append(cname)
    return updated
