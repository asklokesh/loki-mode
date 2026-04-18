"""Spec management for Magic Modules.

Specs are markdown files describing desired component behavior. They are
the source of truth -- implementations regenerate when specs change.
"""

import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional


SPEC_TEMPLATE = """# {name}

## Description
{description}

## Props
- `prop1` (string, required): Description
- `prop2` (boolean, optional, default=false): Description

## Behavior
Describe how the component behaves, state transitions, user interactions.

## Visual / Styling
Describe the visual design: colors, spacing, typography, responsive behavior.

## Accessibility
- Keyboard navigation: [describe]
- Screen reader: [describe]
- Focus management: [describe]

## Examples
```tsx
<{name} prop1="value" />
```
"""


@dataclass
class ComponentSpec:
    """Structured representation of a component spec."""

    name: str
    description: str
    markdown: str
    props: dict = field(default_factory=dict)
    behavior: str = ""
    visual: str = ""
    a11y: list = field(default_factory=list)
    examples: list = field(default_factory=list)


class SpecManager:
    """Manage component specs stored as markdown under .loki/magic/specs/."""

    # Matches a bullet prop line like:
    #   - `name` (type, required): description
    #   - `name` (type, optional, default=false): description
    _PROP_LINE = re.compile(
        r"^\s*[-*]\s*`(?P<name>[^`]+)`\s*"
        r"(?:\((?P<meta>[^)]*)\))?"
        r"\s*:\s*(?P<desc>.*)$"
    )

    # Code fences used to extract examples.
    _CODE_FENCE = re.compile(
        r"```(?P<lang>[a-zA-Z0-9_+-]*)\n(?P<code>.*?)```",
        re.DOTALL,
    )

    def __init__(self, project_dir: str = "."):
        self.specs_dir = Path(project_dir) / ".loki" / "magic" / "specs"
        self.specs_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create_spec(self, name: str, description: str) -> ComponentSpec:
        """Create a new spec file from a description.

        This creates a scaffolded spec using SPEC_TEMPLATE. A caller can
        later enrich the markdown via AI assistance and re-save.
        """
        safe_name = self._sanitize_name(name)
        markdown = SPEC_TEMPLATE.format(name=safe_name, description=description)
        spec = self.parse_markdown(markdown)
        # parse_markdown may extract a slightly different name; honor the
        # requested one for filesystem purposes.
        spec.name = safe_name
        self.save_spec(spec)
        return spec

    def load_spec(self, name: str) -> Optional[ComponentSpec]:
        """Load existing spec by name."""
        path = self._spec_path(name)
        if not path.exists():
            return None
        markdown = path.read_text(encoding="utf-8")
        spec = self.parse_markdown(markdown)
        # Filesystem name is authoritative.
        spec.name = self._sanitize_name(name)
        return spec

    def save_spec(self, spec: ComponentSpec) -> Path:
        """Write spec to disk as .loki/magic/specs/<name>.md."""
        path = self._spec_path(spec.name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(spec.markdown, encoding="utf-8")
        return path

    def parse_markdown(self, md_text: str) -> ComponentSpec:
        """Parse markdown into a structured ComponentSpec.

        Recognized sections (case-insensitive header match):
            # <Component Name>
            ## Description
            ## Props
            ## Behavior
            ## Visual / Styling   (also: Visual, Styling)
            ## Accessibility      (also: A11y)
            ## Examples
        """
        sections = self._split_sections(md_text)

        name = sections.get("__title__", "").strip() or "Component"
        description = sections.get("description", "").strip()
        behavior = sections.get("behavior", "").strip()
        visual = (
            sections.get("visual / styling")
            or sections.get("visual")
            or sections.get("styling")
            or ""
        ).strip()

        props_text = sections.get("props", "")
        props = self._parse_props(props_text)

        a11y_text = (
            sections.get("accessibility")
            or sections.get("a11y")
            or ""
        )
        a11y = self._parse_bullets(a11y_text)

        examples_text = sections.get("examples", "")
        examples = self._parse_examples(examples_text)

        return ComponentSpec(
            name=name,
            description=description,
            markdown=md_text,
            props=props,
            behavior=behavior,
            visual=visual,
            a11y=a11y,
            examples=examples,
        )

    def list_specs(self) -> list:
        """List all spec names (without the .md extension)."""
        if not self.specs_dir.exists():
            return []
        return sorted(p.stem for p in self.specs_dir.glob("*.md"))

    def delete_spec(self, name: str) -> bool:
        """Delete spec file. Returns True if removed, False if not found."""
        path = self._spec_path(name)
        if not path.exists():
            return False
        path.unlink()
        return True

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _spec_path(self, name: str) -> Path:
        return self.specs_dir / f"{self._sanitize_name(name)}.md"

    @staticmethod
    def _sanitize_name(name: str) -> str:
        """Strip whitespace and any path separators from a spec name."""
        cleaned = name.strip()
        # Disallow path traversal characters.
        cleaned = cleaned.replace("/", "_").replace("\\", "_")
        return cleaned

    @staticmethod
    def _split_sections(md_text: str) -> dict:
        """Split markdown into sections keyed by lowercased heading text.

        The first H1 is stored under the special key '__title__'.
        """
        sections: dict = {}
        current_key: Optional[str] = None
        buffer: list = []
        title_captured = False

        def flush():
            if current_key is not None:
                sections[current_key] = "\n".join(buffer).strip("\n")

        for line in md_text.splitlines():
            h1 = re.match(r"^#\s+(.*?)\s*$", line)
            h2 = re.match(r"^##\s+(.*?)\s*$", line)
            if h1 and not title_captured:
                sections["__title__"] = h1.group(1).strip()
                title_captured = True
                # Reset buffer so title body does not leak into next section.
                if current_key is not None:
                    flush()
                    buffer = []
                    current_key = None
                continue
            if h2:
                # Close previous section.
                flush()
                current_key = h2.group(1).strip().lower()
                buffer = []
                continue
            buffer.append(line)

        flush()
        return sections

    @classmethod
    def _parse_props(cls, props_text: str) -> dict:
        """Parse a bullet list of prop definitions into a dict.

        Each entry looks like:
            - `name` (type, required): description
            - `name` (type, optional, default=false): description
        """
        props: dict = {}
        for raw in props_text.splitlines():
            line = raw.rstrip()
            if not line.strip():
                continue
            match = cls._PROP_LINE.match(line)
            if not match:
                continue
            name = match.group("name").strip()
            meta_raw = (match.group("meta") or "").strip()
            desc = match.group("desc").strip()

            prop_type = ""
            required = False
            default = None
            extras: list = []

            if meta_raw:
                parts = [p.strip() for p in meta_raw.split(",") if p.strip()]
                for idx, part in enumerate(parts):
                    lowered = part.lower()
                    if idx == 0 and "=" not in part and lowered not in (
                        "required",
                        "optional",
                    ):
                        prop_type = part
                        continue
                    if lowered == "required":
                        required = True
                    elif lowered == "optional":
                        required = False
                    elif "=" in part:
                        key, _, value = part.partition("=")
                        key = key.strip().lower()
                        value = value.strip()
                        if key == "default":
                            default = value
                        else:
                            extras.append(part)
                    else:
                        extras.append(part)

            props[name] = {
                "type": prop_type,
                "required": required,
                "default": default,
                "description": desc,
                "extras": extras,
            }
        return props

    @staticmethod
    def _parse_bullets(text: str) -> list:
        """Extract bullet list items as plain strings."""
        items: list = []
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith(("-", "*")):
                items.append(line[1:].strip())
        return items

    @classmethod
    def _parse_examples(cls, text: str) -> list:
        """Extract fenced code blocks as example dicts."""
        examples: list = []
        for match in cls._CODE_FENCE.finditer(text):
            lang = (match.group("lang") or "").strip()
            code = match.group("code")
            examples.append({"language": lang, "code": code})
        return examples


# ---------------------------------------------------------------------------
# Module-level convenience API (called by autonomy/loki cmd_magic)
# ---------------------------------------------------------------------------

def generate_spec(name: str, out_path: str, from_spec=None, from_screenshot=None, description: str = "") -> str:
    """Generate or copy a component spec to out_path.

    If from_spec is given, copy its contents. If from_screenshot, delegate to
    the generator's vision path. Otherwise create a template from SPEC_TEMPLATE.
    Returns the path written.
    """
    from pathlib import Path as _P
    out = _P(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    if from_spec:
        out.write_text(_P(from_spec).read_text())
        return str(out)
    if from_screenshot:
        try:
            from magic.core.generator import ComponentGenerator
            md = ComponentGenerator().generate_from_screenshot(from_screenshot, name)
            out.write_text(md)
            return str(out)
        except Exception:
            pass
    desc = description or f"Loki Magic component {name}."
    out.write_text(SPEC_TEMPLATE.format(name=name, description=desc))
    return str(out)
