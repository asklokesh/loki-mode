"""Design token management for Magic Modules.

Tokens guide component generation so output matches Loki Mode's design
language. Loaded from magic/tokens/defaults.json, project overrides at
.loki/magic/tokens.json, and extracted from existing codebase.
"""

import json
import re
from collections import Counter
from pathlib import Path
from typing import Optional


# Standard Tailwind spacing scale in pixels. Tailwind uses 0.25rem per step
# (assuming 16px root), so step N maps to N * 4px.
_TAILWIND_SPACING_PX = 4

# Common spacing buckets we care about, ordered for nearest-match.
_SPACING_BUCKETS = [
    ("xs", 4),
    ("sm", 8),
    ("md", 12),
    ("lg", 16),
    ("xl", 24),
    ("2xl", 32),
    ("3xl", 48),
]

# Files/globs we scan during codebase extraction.
_CSS_GLOBS = [
    "web-app/src/index.css",
    "web-app/src/**/*.css",
    "dashboard-ui/**/*.css",
    "dashboard-ui/loki-unified-styles.js",
    "dashboard/static/**/*.css",
]

_TSX_GLOBS = [
    "web-app/src/**/*.tsx",
    "web-app/src/**/*.jsx",
    "dashboard-ui/**/*.tsx",
    "dashboard-ui/**/*.jsx",
]


class DesignTokens:
    """Load, extract, and render design tokens for component generation."""

    def __init__(self, project_dir: str = "."):
        self.project_dir = Path(project_dir).resolve()
        self._tokens: Optional[dict] = None

    @property
    def tokens(self) -> dict:
        if self._tokens is None:
            self._tokens = self.load()
        return self._tokens

    # ------------------------------------------------------------------ load
    def load(self) -> dict:
        """Load tokens with precedence: defaults < project override.

        Defaults from magic/tokens/defaults.json (packaged).
        Project override from .loki/magic/tokens.json (user-editable).
        """
        merged = self._load_defaults()

        override_path = self.project_dir / ".loki" / "magic" / "tokens.json"
        if override_path.exists():
            try:
                with override_path.open("r", encoding="utf-8") as fh:
                    override = json.load(fh)
            except (json.JSONDecodeError, OSError):
                override = {}
            merged = self._deep_merge(merged, override)

        self._tokens = merged
        return merged

    def _load_defaults(self) -> dict:
        """Locate defaults.json. Prefer packaged path next to this module,
        fall back to project-local magic/tokens/defaults.json."""
        candidates = [
            Path(__file__).resolve().parent.parent / "tokens" / "defaults.json",
            self.project_dir / "magic" / "tokens" / "defaults.json",
        ]
        for path in candidates:
            if path.exists():
                try:
                    with path.open("r", encoding="utf-8") as fh:
                        return json.load(fh)
                except (json.JSONDecodeError, OSError):
                    continue
        # Absolute fallback: empty scaffold so callers never crash.
        return {
            "colors": {},
            "spacing": {},
            "typography": {},
            "radii": {},
            "shadows": {},
            "motion": {},
        }

    @staticmethod
    def _deep_merge(base: dict, override: dict) -> dict:
        """Merge override into base, recursing into dicts."""
        result = dict(base)
        for key, value in override.items():
            if (
                key in result
                and isinstance(result[key], dict)
                and isinstance(value, dict)
            ):
                result[key] = DesignTokens._deep_merge(result[key], value)
            else:
                result[key] = value
        return result

    # --------------------------------------------------------------- extract
    def extract_from_codebase(self, save: bool = False) -> dict:
        """Scan existing components and extract observed tokens.

        Scans:
        - web-app/src/index.css for CSS custom properties
        - dashboard-ui/loki-unified-styles.js for design system vars
        - Tailwind classes in .tsx files for spacing/color patterns

        Returns the observed token set. If save=True, writes to
        .loki/magic/tokens.json.
        """
        observed: dict = {
            "colors": {},
            "spacing": {},
            "typography": {},
            "radii": {},
            "shadows": {},
        }

        # --color-primary: #553DE9;
        css_var_re = re.compile(r"--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);")
        # Tailwind spacing utilities like p-4, m-2, gap-6, px-3
        tw_spacing_re = re.compile(
            r"\b(?:p|m|gap|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr|space-x|space-y)-(\d+)\b"
        )
        # Hex colors #abc / #aabbcc / #aabbccdd
        hex_color_re = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
        # font-family declarations
        font_family_re = re.compile(
            r"font-family\s*:\s*([^;]+);", re.IGNORECASE
        )
        # border-radius values (8px, 0.5rem, 9999px)
        radius_re = re.compile(
            r"border-radius\s*:\s*([0-9.]+(?:px|rem|em|%)|9999px);",
            re.IGNORECASE,
        )
        # box-shadow declarations
        shadow_re = re.compile(
            r"box-shadow\s*:\s*([^;]+);", re.IGNORECASE
        )

        color_counter: Counter = Counter()
        spacing_counter: Counter = Counter()
        font_counter: Counter = Counter()
        radius_counter: Counter = Counter()
        shadow_counter: Counter = Counter()

        # ---- Scan CSS / JS style files -----------------------------------
        for pattern in _CSS_GLOBS:
            for path in self._glob(pattern):
                content = self._read(path)
                if not content:
                    continue

                # Named custom properties go straight into observed map.
                for name, value in css_var_re.findall(content):
                    value = value.strip()
                    key = name.lower()
                    if self._looks_like_color(value):
                        observed["colors"][key] = value
                        color_counter[value] += 1
                    elif self._looks_like_length(value):
                        observed["spacing"].setdefault(key, value)
                    elif "font" in key:
                        observed["typography"].setdefault(key, value)

                for match in hex_color_re.findall(content):
                    color_counter["#" + match.upper()] += 1

                for match in font_family_re.findall(content):
                    font_counter[match.strip()] += 1

                for match in radius_re.findall(content):
                    radius_counter[match.strip()] += 1

                for match in shadow_re.findall(content):
                    shadow_counter[match.strip()] += 1

        # ---- Scan TSX/JSX for Tailwind spacing usage ---------------------
        for pattern in _TSX_GLOBS:
            for path in self._glob(pattern):
                content = self._read(path)
                if not content:
                    continue
                for step in tw_spacing_re.findall(content):
                    try:
                        px = int(step) * _TAILWIND_SPACING_PX
                    except ValueError:
                        continue
                    spacing_counter[f"{px}px"] += 1
                for match in hex_color_re.findall(content):
                    color_counter["#" + match.upper()] += 1

        # ---- Promote most-common raw hits into observed sets -------------
        for value, _count in color_counter.most_common(24):
            if value not in observed["colors"].values():
                key = self._slugify_color(value)
                observed["colors"].setdefault(key, value)

        for value, _count in spacing_counter.most_common(12):
            bucket = self._nearest_spacing_bucket(value)
            if bucket and bucket not in observed["spacing"]:
                observed["spacing"][bucket] = value

        for value, _count in font_counter.most_common(4):
            key = "font-sans" if "sans" in value.lower() or "inter" in value.lower() else (
                "font-mono" if "mono" in value.lower() else "font-serif"
            )
            observed["typography"].setdefault(key, value)

        for value, count in radius_counter.most_common(6):
            # label by size: 4px -> sm, 8px -> lg, 9999px -> full
            label = self._label_radius(value)
            observed["radii"].setdefault(label, value)

        for value, _count in shadow_counter.most_common(4):
            # Just record the first few under size-ordered slots.
            for slot in ("sm", "md", "lg"):
                if slot not in observed["shadows"]:
                    observed["shadows"][slot] = value
                    break

        if save:
            out_dir = self.project_dir / ".loki" / "magic"
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / "tokens.json"
            with out_path.open("w", encoding="utf-8") as fh:
                json.dump(observed, fh, indent=2, sort_keys=True)
                fh.write("\n")

        return observed

    # ------------------------------------------------------------- renderers
    def to_tailwind_config(self) -> dict:
        """Convert tokens to a Tailwind theme extension dict."""
        t = self.tokens
        colors = dict(t.get("colors", {}))
        spacing = dict(t.get("spacing", {}))
        fonts = t.get("typography", {})

        font_family = {}
        font_size = {}
        for key, value in fonts.items():
            if key.startswith("font-"):
                family_key = key[len("font-"):]
                font_family[family_key] = [
                    piece.strip() for piece in value.split(",")
                ]
            elif key.startswith("size-"):
                size_key = key[len("size-"):]
                font_size[size_key] = value

        return {
            "theme": {
                "extend": {
                    "colors": colors,
                    "spacing": spacing,
                    "fontFamily": font_family,
                    "fontSize": font_size,
                    "borderRadius": dict(t.get("radii", {})),
                    "boxShadow": dict(t.get("shadows", {})),
                    "transitionDuration": {
                        k.replace("duration-", ""): v
                        for k, v in t.get("motion", {}).items()
                        if k.startswith("duration-")
                    },
                    "transitionTimingFunction": {
                        k.replace("ease-", ""): v
                        for k, v in t.get("motion", {}).items()
                        if k.startswith("ease-")
                    },
                }
            }
        }

    def to_css_variables(self) -> str:
        """Convert tokens to :root { --var: value } CSS."""
        t = self.tokens
        lines = [":root {"]
        prefix_map = [
            ("color", "colors"),
            ("space", "spacing"),
            ("font", "typography"),
            ("radius", "radii"),
            ("shadow", "shadows"),
            ("motion", "motion"),
        ]
        for prefix, group_key in prefix_map:
            group = t.get(group_key, {})
            if not group:
                continue
            lines.append(f"  /* {group_key} */")
            for key, value in group.items():
                safe_key = re.sub(r"[^a-zA-Z0-9-]", "-", str(key)).lower()
                lines.append(f"  --{prefix}-{safe_key}: {value};")
        lines.append("}")
        return "\n".join(lines) + "\n"

    def to_prompt_context(self) -> str:
        """Format tokens as a concise context block for AI generation prompts."""
        t = self.tokens
        colors = t.get("colors", {})
        spacing = t.get("spacing", {})
        typography = t.get("typography", {})
        radii = t.get("radii", {})

        color_items = ", ".join(
            f"{k}={v}" for k, v in list(colors.items())[:10]
        )
        spacing_items = ", ".join(
            f"{k}={v}" for k, v in spacing.items()
        )
        radii_items = ", ".join(
            f"{k}={v}" for k, v in radii.items()
        )

        font_sans = typography.get("font-sans", "")
        font_mono = typography.get("font-mono", "")
        typo_summary_parts = []
        if font_sans:
            typo_summary_parts.append(f"{font_sans.split(',')[0].strip()} (body)")
        if font_mono:
            typo_summary_parts.append(f"{font_mono.split(',')[0].strip()} (code)")
        typo_summary = ", ".join(typo_summary_parts) if typo_summary_parts else "default stack"

        lines = [
            "DESIGN TOKENS:",
            f"Colors: {color_items}" if color_items else "Colors: (none defined)",
            f"Spacing: {spacing_items}" if spacing_items else "Spacing: (none defined)",
            f"Typography: {typo_summary}",
            f"Radii: {radii_items}" if radii_items else "Radii: (none defined)",
        ]
        return "\n".join(lines)

    # --------------------------------------------------------------- helpers
    def _glob(self, pattern: str):
        """Return matching files inside the project dir for a glob pattern."""
        try:
            return sorted(self.project_dir.glob(pattern))
        except (ValueError, OSError):
            return []

    @staticmethod
    def _read(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return ""

    @staticmethod
    def _looks_like_color(value: str) -> bool:
        v = value.strip().lower()
        if v.startswith("#") and re.fullmatch(r"#[0-9a-f]{3,8}", v):
            return True
        return v.startswith(("rgb(", "rgba(", "hsl(", "hsla("))

    @staticmethod
    def _looks_like_length(value: str) -> bool:
        v = value.strip().lower()
        return bool(re.fullmatch(r"[0-9.]+(px|rem|em|%)", v))

    @staticmethod
    def _slugify_color(value: str) -> str:
        v = value.strip().lstrip("#").lower()
        return f"c-{v}"

    @staticmethod
    def _nearest_spacing_bucket(value: str) -> Optional[str]:
        match = re.match(r"([0-9.]+)px", value)
        if not match:
            return None
        try:
            px = float(match.group(1))
        except ValueError:
            return None
        best_label = None
        best_diff = None
        for label, bucket_px in _SPACING_BUCKETS:
            diff = abs(px - bucket_px)
            if best_diff is None or diff < best_diff:
                best_label = label
                best_diff = diff
        return best_label

    @staticmethod
    def _label_radius(value: str) -> str:
        v = value.strip().lower()
        if v in ("9999px", "50%"):
            return "full"
        match = re.match(r"([0-9.]+)px", v)
        if not match:
            return "md"
        try:
            px = float(match.group(1))
        except ValueError:
            return "md"
        if px <= 4:
            return "sm"
        if px <= 6:
            return "md"
        if px <= 9:
            return "lg"
        return "xl"


__all__ = ["DesignTokens"]


# ---------------------------------------------------------------------------
# Module-level convenience API
# ---------------------------------------------------------------------------

def load_tokens(project_dir: str = ".") -> dict:
    """Convenience wrapper returning DesignTokens(project_dir).tokens."""
    return DesignTokens(project_dir).tokens
