#!/usr/bin/env python3
"""Detect rendered mock operational data with collection-level binding."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


RESOLUTION_EXTENSIONS = (
    ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cts", ".cjs", ".vue", ".svelte",
)
SOURCE_EXTENSIONS = frozenset(RESOLUTION_EXTENSIONS)
SOURCE_INDEX_EXCLUDE = re.compile(
    r"(^|/)(node_modules|\.git|\.loki|\.next|\.cache|dist|build|out|coverage|"
    r"storybook)(/|$)|\.d\.(?:ts|mts|cts)$",
    re.IGNORECASE,
)
RENDER_EXCLUDE = re.compile(
    r"(^|/)(node_modules|\.git|\.loki|\.next|\.cache|dist|build|out|coverage|"
    r"__mocks__|__tests__|__fixtures__|fixtures?|mocks?|stories|storybook)(/|$)"
    r"|\.(test|spec|stories|story|mock|fixture)\."
    r"|\.d\.(?:ts|mts|cts)$|(^|/)msw|(^|/)setup",
    re.IGNORECASE,
)
DECLARATION = re.compile(
    r"\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*"
    r"(?::[^=;]+)?=\s*",
    re.MULTILINE,
)
NAMED_IMPORT = re.compile(
    r"\bimport\s*\{([^}]+)\}\s*from\s*[\"']([^\"']+)[\"']",
    re.MULTILINE,
)
DEFAULT_IMPORT = re.compile(
    r"\bimport\s+(?!type\b)([A-Za-z_$][\w$]*)\s+from\s*[\"']([^\"']+)[\"']",
    re.MULTILINE,
)
DEFAULT_EXPORT_IDENTIFIER = re.compile(
    r"\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?",
    re.MULTILINE,
)
DEFAULT_EXPORT = re.compile(r"\bexport\s+default\s+", re.MULTILINE)
NAMED_REEXPORT = re.compile(
    r"\bexport\s*\{([^}]+)\}\s*from\s*[\"']([^\"']+)[\"']",
    re.MULTILINE,
)
STAR_REEXPORT = re.compile(
    r"\bexport\s*\*\s*from\s*[\"']([^\"']+)[\"']",
    re.MULTILINE,
)
FAKER = re.compile(r"\bfaker\s*\.", re.IGNORECASE)
PLACEHOLDER_VALUE = re.compile(
    r"lorem ipsum|john doe|jane doe|dummy data|example@example"
    r"|\b(?:mock|fake|dummy|placeholder)(?:Data|Users?|Orders?|Customers?|Rows?|Records?)\b",
    re.IGNORECASE,
)
EXPLICIT_MOCK_TOKEN = {"mock", "fake", "dummy", "placeholder", "sample", "fixture"}
OPERATIONAL_TOKEN = {
    "user", "users", "order", "orders", "customer", "customers", "account",
    "accounts", "invoice", "invoices", "payment", "payments", "transaction",
    "transactions", "record", "records", "row", "rows", "ticket", "tickets",
    "message", "messages", "notification", "notifications", "activity",
    "activities", "event", "events", "metric", "metrics", "analytics",
    "dashboard", "task", "tasks", "note", "notes", "product", "products",
    "member", "members", "project", "projects", "job", "jobs", "lead",
    "leads", "contact", "contacts", "subscription", "subscriptions",
    "deployment", "deployments", "build", "builds",
}
STATIC_CONTENT_TOKEN = {
    "feature", "features", "benefit", "benefits", "plan", "plans", "pricing",
    "testimonial", "testimonials", "story", "stories", "comparison",
    "comparisons", "faq", "faqs", "navigation", "nav", "logo", "logos",
    "step", "steps", "tier", "tiers", "quote", "quotes",
}
JSX_TAG = re.compile(r"<[A-Za-z][A-Za-z0-9_.:-]*\b")
DIRECT_COLLECTION_PROP = re.compile(
    r"<(?:DataGrid|Table|List|Grid)\b[^>]*\b(?:rows|dataSource|items|data)\s*=\s*"
    r"\{\s*([A-Za-z_$][\w$]*)[^{}]{0,500}\}",
    re.IGNORECASE | re.DOTALL,
)
VUE_LOOP = re.compile(
    r"\bv-for\s*=\s*[\"'][^\"']*\bin\s+([A-Za-z_$][\w$]*)[^\"']*[\"']",
    re.IGNORECASE,
)
SVELTE_LOOP = re.compile(
    r"\{#each\s+([A-Za-z_$][\w$]*)\s+as\b",
    re.IGNORECASE,
)
DIRECT_INLINE_MAP = re.compile(
    r"\[\s*\{(?P<body>.{0,4000}?)\}\s*(?:,\s*\{.{0,4000}?\}\s*)*\]"
    r"\s*\.map\s*\(",
    re.DOTALL,
)
OPERATIONAL_FIELD = re.compile(
    r"\b(?:id|email|role|status|amount|total|customer|order|user|invoice|payment|transaction)\s*:",
    re.IGNORECASE,
)
STRONG_OPERATIONAL_FIELD = re.compile(
    r"\b(?:email|role|amount|total|customer|order|user|invoice|payment|transaction)\s*:",
    re.IGNORECASE,
)
STATIC_CONTENT_FIELD = re.compile(
    r"\b(?:feature|title|description|benefit|plan|price|quote|question|answer|logo|step|tier)\s*:",
    re.IGNORECASE,
)
STATE_DECLARATION = re.compile(
    r"\b(?:export\s+)?(?:const|let|var)\s*\[\s*([A-Za-z_$][\w$]*)[^\]]*\]"
    r"\s*(?::[^=;]+)?=\s*",
    re.MULTILINE,
)


@dataclass(frozen=True)
class Declaration:
    file: str
    name: str
    expression: str
    line: int


def _identifier_tokens(name: str) -> list[str]:
    expanded = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    return [token.lower() for token in re.split(r"[^A-Za-z0-9]+", expanded) if token]


def _read_initializer(source: str, start: int) -> str:
    """Read a JavaScript initializer through its top-level semicolon."""

    depth = 0
    quote = ""
    escaped = False
    index = start
    limit = min(len(source), start + 50000)
    while index < limit:
        char = source[index]
        next_char = source[index + 1] if index + 1 < limit else ""
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            index += 1
            continue
        if char in "\"'`":
            quote = char
        elif char == "/" and next_char == "/":
            newline = source.find("\n", index + 2, limit)
            index = limit if newline < 0 else newline
            continue
        elif char == "/" and next_char == "*":
            close = source.find("*/", index + 2, limit)
            index = limit if close < 0 else close + 2
            continue
        elif char in "([{":
            depth += 1
        elif char in ")]}" and depth > 0:
            depth -= 1
        elif char == ";" and depth == 0:
            return source[start:index]
        elif char == "\n" and depth == 0:
            remainder = source[index + 1:limit]
            if re.match(
                r"\s*(?:(?:export\s+)?(?:const|let|var|function|class)\b|"
                r"import\b|export\s+(?:default|\{|\*))",
                remainder,
            ):
                return source[start:index]
        index += 1
    return source[start:limit]


def _declarations(relative: str, source: str) -> dict[str, Declaration]:
    found: dict[str, Declaration] = {}
    for match in DECLARATION.finditer(source):
        name = match.group(1)
        found[name] = Declaration(
            file=relative,
            name=name,
            expression=_read_initializer(source, match.end()),
            line=source.count("\n", 0, match.start()) + 1,
        )
    for match in STATE_DECLARATION.finditer(source):
        name = match.group(1)
        found[name] = Declaration(
            file=relative,
            name=name,
            expression=_read_initializer(source, match.end()),
            line=source.count("\n", 0, match.start()) + 1,
        )
    return found


def _mock_reason(declaration: Declaration) -> str:
    tokens = _identifier_tokens(declaration.name)
    expression = declaration.expression
    static_content = any(token in STATIC_CONTENT_TOKEN for token in tokens)
    if any(token in EXPLICIT_MOCK_TOKEN for token in tokens) and not static_content:
        return "explicit_mock_collection"
    if FAKER.search(expression):
        return "faker_collection"
    if PLACEHOLDER_VALUE.search(expression):
        return "placeholder_collection"
    inline_objects = re.match(
        r"\s*(?:(?:useState|ref|reactive|readonly|\$state)"
        r"(?:<[^>]{1,500}>)?\s*\(\s*)?\[\s*\{",
        expression,
    ) is not None
    operational_fields = len(OPERATIONAL_FIELD.findall(expression)) >= 2
    strong_operational = STRONG_OPERATIONAL_FIELD.search(expression) is not None
    if inline_objects and not static_content and (
        any(token in OPERATIONAL_TOKEN for token in tokens)
        or (operational_fields and strong_operational)
    ):
        return "inline_operational_collection"
    if (
        re.match(r"\s*Array\.from\s*\(", expression)
        and any(token in OPERATIONAL_TOKEN for token in tokens)
        and not static_content
        and re.search(r"=>\s*\(?\s*\{", expression)
    ):
        return "generated_operational_collection"
    return ""


def _mask_non_code(source: str) -> str:
    """Mask comments and strings while preserving positions and newlines."""

    masked = list(source)
    index = 0
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if char == "/" and next_char == "/":
            end = source.find("\n", index + 2)
            end = len(source) if end < 0 else end
            for position in range(index, end):
                masked[position] = " "
            index = end
            continue
        if char == "/" and next_char == "*":
            end = source.find("*/", index + 2)
            end = len(source) if end < 0 else end + 2
            for position in range(index, end):
                if masked[position] != "\n":
                    masked[position] = " "
            index = end
            continue
        if char in "\"'`":
            quote = char
            end = index + 1
            escaped = False
            while end < len(source):
                current = source[end]
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == quote:
                    end += 1
                    break
                end += 1
            for position in range(index, end):
                if masked[position] != "\n":
                    masked[position] = " "
            index = end
            continue
        index += 1
    return "".join(masked)


def _balanced_parenthesized(source: str, opening: int) -> str:
    if opening < 0 or opening >= len(source) or source[opening] != "(":
        return ""
    depth = 0
    for index in range(opening, min(len(source), opening + 50000)):
        if source[index] == "(":
            depth += 1
        elif source[index] == ")":
            depth -= 1
            if depth == 0:
                return source[opening:index + 1]
    return ""


def _named_callback_renders_jsx(source: str, call: str) -> bool:
    callback = re.match(r"\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))", call)
    if not callback:
        return False
    callback_name = callback.group(1)
    for declaration in _declarations("", source).values():
        if (
            declaration.name == callback_name
            and "=>" in declaration.expression
            and JSX_TAG.search(declaration.expression)
        ):
            return True
    name = re.escape(callback_name)
    function = re.search(
        rf"\bfunction\s+{name}\s*\([^)]*\)\s*\{{.{{0,5000}}?\breturn\s+(<[A-Za-z][A-Za-z0-9_.:-]*\b)",
        source,
        re.DOTALL,
    )
    return function is not None


def _skip_balanced_backward(source: str, index: int) -> int:
    """Return the index before a balanced parenthesized expression."""

    depth = 0
    quote = ""
    escaped = False
    while index >= 0:
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            index -= 1
            continue
        if char in "\"'`":
            quote = char
        elif char == ")":
            depth += 1
        elif char == "(":
            depth -= 1
            if depth == 0:
                return index - 1
        index -= 1
    return -1


def _map_collection_root(source: str, map_dot: int) -> str:
    """Trace `collection.filter(...).map` back to its root identifier."""

    index = map_dot - 1
    candidate = ""
    while index >= 0:
        while index >= 0 and source[index].isspace():
            index -= 1
        if index >= 0 and source[index] == ")":
            index = _skip_balanced_backward(source, index)
            while index >= 0 and source[index].isspace():
                index -= 1
        end = index + 1
        while index >= 0 and (source[index].isalnum() or source[index] in "_$"):
            index -= 1
        if end == index + 1:
            return candidate
        candidate = source[index + 1:end]
        while index >= 0 and source[index].isspace():
            index -= 1
        if index >= 0 and source[index] == "?":
            index -= 1
        if index >= 0 and source[index] == ".":
            index -= 1
            continue
        return candidate
    return candidate


def _rendered_symbols(source: str) -> set[str]:
    rendered: set[str] = set()
    structural = _mask_non_code(source)
    for match in re.finditer(r"(?:\?\.|\.)\s*map\s*\(", structural):
        call = _balanced_parenthesized(structural, match.end() - 1)
        if JSX_TAG.search(call) or _named_callback_renders_jsx(structural, call):
            root = _map_collection_root(structural, match.start())
            if root:
                rendered.add(root)
    rendered.update(match.group(1) for match in DIRECT_COLLECTION_PROP.finditer(structural))
    rendered.update(match.group(1) for match in VUE_LOOP.finditer(source))
    rendered.update(match.group(1) for match in SVELTE_LOOP.finditer(source))
    return rendered


def _named_imports(source: str) -> dict[str, tuple[str, str]]:
    imports: dict[str, tuple[str, str]] = {}
    for match in NAMED_IMPORT.finditer(source):
        module = match.group(2)
        for raw_binding in match.group(1).split(","):
            binding = raw_binding.strip()
            if not binding:
                continue
            parts = re.split(r"\s+as\s+", binding, maxsplit=1)
            imported = parts[0].strip()
            local = parts[-1].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", imported) and re.fullmatch(
                r"[A-Za-z_$][\w$]*", local
            ):
                imports[local] = (module, imported)
    for match in DEFAULT_IMPORT.finditer(source):
        imports[match.group(1)] = (match.group(2), "default")
    return imports


def _jsonc_object(path: Path) -> dict[str, object]:
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    source = re.sub(r"(^|\s)//.*$", r"\1", source, flags=re.MULTILINE)
    source = re.sub(r",\s*([}\]])", r"\1", source)
    try:
        value = json.loads(source)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _module_bases(root: Path, importer: str, module: str) -> Iterable[Path]:
    if module.startswith("."):
        yield (root / importer).parent / module
        return

    matched = False
    for config_name in ("tsconfig.json", "jsconfig.json"):
        config = _jsonc_object(root / config_name)
        compiler = config.get("compilerOptions")
        if not isinstance(compiler, dict):
            continue
        base_url = compiler.get("baseUrl", ".")
        base = root / (base_url if isinstance(base_url, str) else ".")
        paths = compiler.get("paths")
        if not isinstance(paths, dict):
            continue
        for pattern, replacements in paths.items():
            if not isinstance(pattern, str) or not isinstance(replacements, list):
                continue
            prefix, marker, suffix = pattern.partition("*")
            if marker:
                if not module.startswith(prefix) or not module.endswith(suffix):
                    continue
                wildcard = module[len(prefix):len(module) - len(suffix) if suffix else None]
            elif module == pattern:
                wildcard = ""
            else:
                continue
            for replacement in replacements:
                if isinstance(replacement, str):
                    matched = True
                    yield base / replacement.replace("*", wildcard)
    if not matched and module.startswith(("@/", "~/")):
        yield root / "src" / module[2:]


def _resolve_module(root: Path, importer: str, module: str) -> str:
    candidates: list[Path] = []
    for base in _module_bases(root, importer, module):
        candidates.append(base)
        candidates.extend(Path(str(base) + suffix) for suffix in RESOLUTION_EXTENSIONS)
        candidates.extend(base / ("index" + suffix) for suffix in RESOLUTION_EXTENSIONS)
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            resolved.relative_to(root.resolve())
        except (OSError, ValueError):
            continue
        if resolved.is_file() and resolved.suffix.lower() in SOURCE_EXTENSIONS:
            return resolved.relative_to(root.resolve()).as_posix()
    return ""


def _source_files(tree: Path) -> dict[str, str]:
    sources: dict[str, str] = {}
    for directory, names, files in os.walk(tree, topdown=True, followlinks=False):
        directory_path = Path(directory)
        relative_directory = directory_path.relative_to(tree).as_posix()
        prefix = "" if relative_directory == "." else relative_directory + "/"
        names[:] = sorted(
            name
            for name in names
            if not SOURCE_INDEX_EXCLUDE.search(prefix + name + "/")
            and not (directory_path / name).is_symlink()
        )
        for name in sorted(files):
            path = directory_path / name
            relative = prefix + name
            if path.is_symlink() or path.suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            if SOURCE_INDEX_EXCLUDE.search(relative):
                continue
            try:
                sources[relative] = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
    return sources


def _exported_declaration(
    tree: Path,
    declarations: dict[str, dict[str, Declaration]],
    sources: dict[str, str],
    source_file: str,
    imported_name: str,
    local_name: str,
    seen: set[tuple[str, str]] | None = None,
    trace: set[str] | None = None,
) -> Declaration | None:
    seen = set() if seen is None else seen
    trace = set() if trace is None else trace
    key = (source_file, imported_name)
    if not source_file or key in seen or len(seen) >= 12:
        return None
    seen.add(key)
    trace.add(source_file)
    if imported_name != "default":
        direct = declarations.get(source_file, {}).get(imported_name)
        if direct is not None:
            return direct
    source = sources.get(source_file, "")
    if imported_name == "default":
        identifier = DEFAULT_EXPORT_IDENTIFIER.search(source)
        if identifier:
            direct = declarations.get(source_file, {}).get(identifier.group(1))
            if direct is not None:
                return direct
        exported = DEFAULT_EXPORT.search(source)
        if exported:
            expression = _read_initializer(source, exported.end())
            return Declaration(
                file=source_file,
                name=local_name,
                expression=expression,
                line=source.count("\n", 0, exported.start()) + 1,
            )

    for match in NAMED_REEXPORT.finditer(source):
        module = match.group(2)
        for raw_binding in match.group(1).split(","):
            parts = re.split(r"\s+as\s+", raw_binding.strip(), maxsplit=1)
            original = parts[0].strip()
            exported_name = parts[-1].strip()
            if exported_name != imported_name:
                continue
            target = _resolve_module(tree, source_file, module)
            branch_trace = set(trace)
            resolved = _exported_declaration(
                tree,
                declarations,
                sources,
                target,
                original,
                local_name,
                seen,
                branch_trace,
            )
            if resolved is not None:
                trace.update(branch_trace)
                return resolved
    if imported_name != "default":
        for match in STAR_REEXPORT.finditer(source):
            target = _resolve_module(tree, source_file, match.group(1))
            branch_trace = set(trace)
            resolved = _exported_declaration(
                tree,
                declarations,
                sources,
                target,
                imported_name,
                local_name,
                seen,
                branch_trace,
            )
            if resolved is not None:
                trace.update(branch_trace)
                return resolved
    return None


def _symbol_declaration(
    tree: Path,
    declarations: dict[str, dict[str, Declaration]],
    sources: dict[str, str],
    source_file: str,
    symbol: str,
    trace: set[str] | None = None,
) -> Declaration | None:
    trace = set() if trace is None else trace
    direct = declarations.get(source_file, {}).get(symbol)
    if direct is not None:
        trace.add(source_file)
        return direct
    imported = _named_imports(sources.get(source_file, "")).get(symbol)
    if imported is None:
        return None
    module, imported_name = imported
    target = _resolve_module(tree, source_file, module)
    branch_trace = set(trace)
    resolved = _exported_declaration(
        tree,
        declarations,
        sources,
        target,
        imported_name,
        symbol,
        trace=branch_trace,
    )
    if resolved is not None:
        trace.update(branch_trace)
    return resolved


def _referenced_symbol(expression: str) -> str:
    match = re.match(r"\s*([A-Za-z_$][\w$]*)\s*(?:\?\.)?\.", expression)
    if match and match.group(1) not in {"Array", "Object", "Math", "JSON"}:
        return match.group(1)
    derived = re.match(
        r"\s*(?:useMemo|computed)\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)"
        r"\s*=>\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:\?\.|\.|\[)",
        expression,
    )
    return derived.group(1) if derived else ""


def _bound_mock_reason(
    tree: Path,
    declarations: dict[str, dict[str, Declaration]],
    sources: dict[str, str],
    declaration: Declaration,
    seen: set[tuple[str, str]] | None = None,
    trace: set[str] | None = None,
) -> tuple[Declaration, str] | None:
    seen = set() if seen is None else seen
    trace = set() if trace is None else trace
    key = (declaration.file, declaration.name)
    if key in seen or len(seen) >= 12:
        return None
    seen.add(key)
    trace.add(declaration.file)
    reason = _mock_reason(declaration)
    if reason:
        return declaration, reason
    referenced = _referenced_symbol(declaration.expression)
    if not referenced:
        return None
    upstream = _symbol_declaration(
        tree, declarations, sources, declaration.file, referenced, trace,
    )
    if upstream is None:
        return None
    return _bound_mock_reason(tree, declarations, sources, upstream, seen, trace)


def _changed_digest(files: list[str], tree: Path) -> str:
    digest = hashlib.sha256()
    root = tree.resolve()
    for relative in sorted(set(files)):
        digest.update(relative.encode("utf-8", errors="surrogateescape"))
        digest.update(b"\0")
        path = tree / relative
        try:
            resolved = path.resolve()
            resolved.relative_to(root)
            if path.is_symlink():
                digest.update(b"symlink\0")
                digest.update(os.readlink(path).encode("utf-8", errors="surrogateescape"))
            elif path.is_file():
                digest.update(b"file\0")
                digest.update(hashlib.sha256(path.read_bytes()).digest())
            else:
                digest.update(b"missing\0")
        except (OSError, ValueError):
            digest.update(b"unreadable\0")
        digest.update(b"\0")
    return digest.hexdigest()


def scan(files: list[str], tree: Path) -> tuple[int, dict[str, object] | None]:
    """Return changed sources scanned and the first collection-bound hit."""

    changed = {
        relative
        for relative in files
        if Path(relative).suffix.lower() in SOURCE_EXTENSIONS
        and not SOURCE_INDEX_EXCLUDE.search(relative)
    }
    sources = _source_files(tree)
    scanned = sum(1 for relative in changed if relative in sources)
    declarations = {
        relative: _declarations(relative, source)
        for relative, source in sources.items()
    }

    for render_file, source in sources.items():
        if RENDER_EXCLUDE.search(render_file):
            continue
        rendered = _rendered_symbols(source)
        for local_name in sorted(rendered):
            resolution_trace = {render_file}
            declaration = _symbol_declaration(
                tree,
                declarations,
                sources,
                render_file,
                local_name,
                resolution_trace,
            )
            if declaration is None:
                continue
            bound = _bound_mock_reason(
                tree,
                declarations,
                sources,
                declaration,
                trace=resolution_trace,
            )
            if bound is None:
                continue
            backing, reason = bound
            if changed.isdisjoint(resolution_trace):
                continue
            return scanned, {
                "file": backing.file,
                "line": backing.line,
                "snippet": backing.name[:80],
                "reason": reason,
                "render_file": render_file,
            }

        if render_file in changed:
            structural = _mask_non_code(source)
            for match in DIRECT_INLINE_MAP.finditer(structural):
                body = source[match.start("body"):match.end("body")]
                call = _balanced_parenthesized(structural, match.end() - 1)
                operational_fields = len(OPERATIONAL_FIELD.findall(body)) >= 2
                strong_operational = STRONG_OPERATIONAL_FIELD.search(body) is not None
                static_content = STATIC_CONTENT_FIELD.search(body) is not None
                if JSX_TAG.search(call) and (
                    (operational_fields and strong_operational and not static_content)
                    or FAKER.search(body)
                    or PLACEHOLDER_VALUE.search(body)
                ):
                    return scanned, {
                        "file": render_file,
                        "line": source.count("\n", 0, match.start()) + 1,
                        "snippet": "inline array map",
                        "reason": "direct_inline_operational_collection",
                        "render_file": render_file,
                    }
    return scanned, None


def main() -> int:
    # Transport: stdin first, _NM_FILES as fallback. An env string is capped at
    # MAX_ARG_STRLEN (131071 bytes) on Linux, so a large changed-file list makes
    # execve fail with E2BIG -- the caller then captures its own
    # "INCONCLUSIVE:detector_error" fallback and the gate silently passes
    # through. macOS has no per-string cap, which is why that failure was
    # Linux-only. stdin has no such limit.
    # Read defensively: a caller may close stdin (sys.stdin is then None) or
    # hand over a tty. Either way fall back to the env var rather than raising,
    # because an uncaught error here reads to the caller as
    # "INCONCLUSIVE:detector_error" -- the exact silent pass-through this
    # transport change exists to remove.
    raw = ""
    try:
        if sys.stdin is not None and not sys.stdin.isatty():
            raw = sys.stdin.read()
    except (OSError, ValueError):
        raw = ""
    if not raw.strip():
        raw = os.environ.get("_NM_FILES", "")
    files = [line.strip() for line in raw.splitlines() if line.strip()]
    tree = Path(os.environ.get("_NM_TREE", ".")).resolve()
    output = os.environ.get("_NM_OUT", "")
    scanned, hit = scan(files, tree)
    receipt = {
        "schema_version": 2,
        "scanned": scanned,
        "hit": hit is not None,
        "file": hit["file"] if hit else "",
        "line": hit["line"] if hit else 0,
        "snippet": hit["snippet"] if hit else "",
        "reason": hit["reason"] if hit else "",
        "render_file": hit["render_file"] if hit else "",
        "base_sha": os.environ.get("_NM_BASE", ""),
        "source_digest": _changed_digest(files, tree),
    }
    if output:
        try:
            destination = Path(output)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".tmp")
            temporary.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
            temporary.replace(destination)
        except OSError as error:
            print(f"receipt write failed: {error}", file=os.sys.stderr)
            return 2

    if hit:
        print(f"FAIL:{hit['file']}:{hit['line']}:{hit['snippet']}:{hit['reason']}")
    elif scanned == 0:
        print("SKIP:0")
    else:
        print(f"PASS:{scanned}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
