"""SHA-based freshness checking (MagicModules pattern).

When a spec changes, implementations regenerate. When a spec is unchanged,
cached implementations are reused. This is the core efficiency mechanism.
"""

import hashlib
import re
from pathlib import Path
from typing import Optional


HASH_HEADER_PATTERN = re.compile(
    r"^(?://|#|/\*)\s*LOKI-MAGIC-HASH:\s*([a-f0-9]{64})",
    re.MULTILINE,
)


def compute_spec_hash(spec_content: str) -> str:
    """Return the SHA256 hex digest of the spec markdown content."""
    return hashlib.sha256(spec_content.encode("utf-8")).hexdigest()


def extract_hash(generated_code: str) -> Optional[str]:
    """Extract the LOKI-MAGIC-HASH value from a generated code header.

    Returns None when no hash header is present.
    """
    match = HASH_HEADER_PATTERN.search(generated_code)
    return match.group(1) if match else None


def is_fresh(spec_content: str, generated_code: str) -> bool:
    """Return True when generated code's embedded hash matches current spec."""
    expected = compute_spec_hash(spec_content)
    actual = extract_hash(generated_code)
    return actual == expected


def prepend_hash_header(
    code: str,
    spec_content: str,
    comment_style: str = "//",
) -> str:
    """Prepend a hash comment header to generated code.

    comment_style:
        '//' for JS/TS/Dart
        '#'  for Python/YAML
        '/*' for CSS (or any C-style block comment language)
    """
    h = compute_spec_hash(spec_content)
    if comment_style == "//":
        header = (
            f"// LOKI-MAGIC-HASH: {h}\n"
            "// Auto-generated from spec. Edit spec, not this file.\n\n"
        )
    elif comment_style == "#":
        header = (
            f"# LOKI-MAGIC-HASH: {h}\n"
            "# Auto-generated from spec. Edit spec, not this file.\n\n"
        )
    else:
        header = (
            f"/* LOKI-MAGIC-HASH: {h} */\n"
            "/* Auto-generated from spec. Edit spec, not this file. */\n\n"
        )
    return header + code


def needs_regen(spec_path: Path, generated_path: Path) -> bool:
    """Return True when the generated file must be regenerated.

    Rules:
        - Missing generated file     -> regenerate.
        - Missing spec file          -> cannot regenerate (False).
        - Hash mismatch or no hash   -> regenerate.
        - Hash matches current spec  -> do not regenerate.
    """
    if not generated_path.exists():
        return True
    if not spec_path.exists():
        return False
    spec = spec_path.read_text(encoding="utf-8")
    gen = generated_path.read_text(encoding="utf-8")
    return not is_fresh(spec, gen)
