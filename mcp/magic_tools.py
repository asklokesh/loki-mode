"""MCP tools for Magic Modules.

Exposes loki magic functionality to AI coding assistants via the MCP
protocol. Tools delegate to the magic/ package where possible and fall
back to the `loki magic` CLI when direct imports are unavailable.

Registration pattern:
    from mcp.magic_tools import register_magic_tools
    register_magic_tools(mcp_server)   # Called from mcp/server.py

All tools are resilient: they catch exceptions and return structured
error dicts rather than raising, so an MCP client always receives a
well-formed JSON response.
"""

import json
import re
import subprocess
from typing import Any, Dict, List, Optional


# Regex used to validate component names. Mirrors the rule stated in the
# tool docstrings so callers get a consistent, early error.
_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")

# Default timeout (seconds) for CLI subprocess calls. Generation involves
# an LLM round-trip so it can legitimately take a while; we still cap it
# to avoid hanging the MCP server indefinitely.
_CLI_TIMEOUT = 600


def _error(message: str, **extra: Any) -> Dict[str, Any]:
    """Return a structured error dict."""
    result: Dict[str, Any] = {"ok": False, "error": message}
    result.update(extra)
    return result


def _ok(**fields: Any) -> Dict[str, Any]:
    """Return a structured success dict."""
    result: Dict[str, Any] = {"ok": True}
    result.update(fields)
    return result


def _validate_name(name: str) -> Optional[str]:
    """Return an error message if name is invalid, else None."""
    if not isinstance(name, str) or not name:
        return "name must be a non-empty string"
    if not _NAME_RE.match(name):
        return (
            "name must match ^[a-zA-Z][a-zA-Z0-9_-]*$ "
            "(letters, digits, underscore, hyphen; must start with a letter)"
        )
    return None


def _run_loki(args: List[str], timeout: int = _CLI_TIMEOUT) -> Dict[str, Any]:
    """Invoke the `loki` CLI and return a structured result.

    The CLI is expected to emit JSON on stdout for machine consumers. If
    stdout is not valid JSON we surface both stdout and stderr in the
    error response so callers can diagnose.
    """
    cmd = ["loki", *args]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return _error("loki CLI not found on PATH", command=cmd)
    except subprocess.TimeoutExpired:
        return _error(
            "loki CLI timed out", command=cmd, timeout_seconds=timeout
        )
    except Exception as exc:  # pragma: no cover - defensive
        return _error(f"failed to invoke loki CLI: {exc}", command=cmd)

    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()

    if proc.returncode != 0:
        return _error(
            f"loki CLI exited with code {proc.returncode}",
            command=cmd,
            stdout=stdout,
            stderr=stderr,
            returncode=proc.returncode,
        )

    # Try to decode JSON first; fall back to raw stdout if not JSON.
    if stdout:
        try:
            parsed = json.loads(stdout)
            if isinstance(parsed, dict):
                parsed.setdefault("ok", True)
                return parsed
            return _ok(result=parsed)
        except json.JSONDecodeError:
            return _ok(stdout=stdout, stderr=stderr)

    return _ok(stdout=stdout, stderr=stderr)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def loki_magic_generate(
    name: str,
    description: str = "",
    target: str = "react",
    placement: str = "",
    tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Generate a new component from a description.

    Args:
        name: Component name (must match ^[a-zA-Z][a-zA-Z0-9_-]*$).
        description: Natural-language description of what the component does.
        target: 'react' | 'webcomponent' | 'both'.
        placement: Optional file path where the component should be placed.
        tags: List of tags for registry search.

    Returns:
        A dict with keys:
          ok (bool), name (str), spec_path (str),
          react_path (str, if target includes react),
          webcomponent_path (str, if target includes webcomponent),
          version (str), debate_passed (bool)
        On failure: {"ok": False, "error": "..."}.
    """
    err = _validate_name(name)
    if err:
        return _error(err, name=name)

    allowed_targets = {"react", "webcomponent", "both"}
    if target not in allowed_targets:
        return _error(
            f"target must be one of {sorted(allowed_targets)}",
            target=target,
        )

    if tags is not None and not isinstance(tags, list):
        return _error("tags must be a list of strings", tags=tags)

    args: List[str] = ["magic", "generate", name, "--target", target]
    if description:
        args.extend(["--description", description])
    if placement:
        args.extend(["--placement", placement])
    if tags:
        args.extend(["--tags", ",".join(str(t) for t in tags)])

    return _run_loki(args)


def loki_magic_list(
    query: str = "",
    tags: Optional[List[str]] = None,
    target: Optional[str] = None,
) -> Dict[str, Any]:
    """List / search registered components.

    Args:
        query: Substring match against component names.
        tags: Filter by tags (AND logic).
        target: Filter by target framework.

    Returns:
        {"ok": True, "count": int, "components": [...]} on success,
        or a structured error dict on failure.
    """
    if tags is not None and not isinstance(tags, list):
        return _error("tags must be a list of strings", tags=tags)

    try:
        # Prefer direct Python API when available.
        from magic.core.registry import ComponentRegistry  # type: ignore
    except ImportError:
        # Fall back to CLI if the magic package is not importable.
        args: List[str] = ["magic", "list", "--json"]
        if query:
            args.extend(["--query", query])
        if tags:
            args.extend(["--tags", ",".join(str(t) for t in tags)])
        if target:
            args.extend(["--target", target])
        return _run_loki(args)
    except Exception as exc:
        return _error(f"failed to import magic registry: {exc}")

    try:
        reg = ComponentRegistry(".")
        results = reg.search(query=query, tags=tags, target=target)
    except Exception as exc:
        return _error(f"registry search failed: {exc}")

    components = list(results) if results is not None else []
    return _ok(count=len(components), components=components)


def loki_magic_get(name: str) -> Dict[str, Any]:
    """Fetch details for a specific component.

    Args:
        name: Component name (must match ^[a-zA-Z][a-zA-Z0-9_-]*$).

    Returns:
        {"ok": True, "component": {...}} on success,
        or a structured error dict on failure.
    """
    err = _validate_name(name)
    if err:
        return _error(err, name=name)

    try:
        from magic.core.registry import ComponentRegistry  # type: ignore
    except ImportError:
        return _run_loki(["magic", "get", name, "--json"])
    except Exception as exc:
        return _error(f"failed to import magic registry: {exc}")

    try:
        reg = ComponentRegistry(".")
        # Prefer a .get() method if the registry exposes one; otherwise
        # fall back to searching by exact name.
        component: Any = None
        if hasattr(reg, "get"):
            component = reg.get(name)
        elif hasattr(reg, "find"):
            component = reg.find(name)
        else:
            results = reg.search(query=name)
            for item in (results or []):
                if isinstance(item, dict) and item.get("name") == name:
                    component = item
                    break
    except Exception as exc:
        return _error(f"registry lookup failed: {exc}", name=name)

    if component is None:
        return _error(f"component not found: {name}", name=name)
    return _ok(component=component)


def loki_magic_update(
    name: str,
    spec_update: str = "",
    force: bool = False,
) -> Dict[str, Any]:
    """Update a component when its spec has changed.

    Args:
        name: Component name.
        spec_update: Optional updated description / spec text to apply
            before regeneration.
        force: If False (default), only regenerates when the spec hash
            has diverged. If True, always regenerates.

    Returns:
        A dict describing the update result on success, or a structured
        error dict on failure.
    """
    err = _validate_name(name)
    if err:
        return _error(err, name=name)

    args: List[str] = ["magic", "update", name]
    if spec_update:
        args.extend(["--spec-update", spec_update])
    if force:
        args.append("--force")
    args.append("--json")

    return _run_loki(args)


def loki_magic_debate(
    name: str,
    rounds: int = 3,
    personas: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Run multi-persona debate on an existing component.

    Args:
        name: Component name.
        rounds: Number of debate rounds (default 3).
        personas: Optional list of persona identifiers. When omitted,
            the debate runner uses its default persona set.

    Returns:
        Debate result including critiques and (if applicable) refined
        code, or a structured error dict on failure.
    """
    err = _validate_name(name)
    if err:
        return _error(err, name=name)

    if not isinstance(rounds, int) or rounds < 1:
        return _error("rounds must be a positive integer", rounds=rounds)

    if personas is not None and not isinstance(personas, list):
        return _error("personas must be a list of strings", personas=personas)

    try:
        from magic.core.debate import DebateRunner  # type: ignore
    except ImportError:
        args: List[str] = ["magic", "debate", name, "--rounds", str(rounds)]
        if personas:
            args.extend(["--personas", ",".join(str(p) for p in personas)])
        args.append("--json")
        return _run_loki(args)
    except Exception as exc:
        return _error(f"failed to import debate runner: {exc}")

    try:
        runner_kwargs: Dict[str, Any] = {"rounds": rounds}
        if personas:
            runner_kwargs["personas"] = personas
        # DebateRunner's exact constructor signature is defined by the
        # magic package. We pass the workspace root positionally and
        # forward debate params as kwargs, staying tolerant of minor
        # signature differences.
        try:
            runner = DebateRunner(".", **runner_kwargs)
        except TypeError:
            runner = DebateRunner(".")
            for attr, value in runner_kwargs.items():
                try:
                    setattr(runner, attr, value)
                except Exception:
                    pass

        if hasattr(runner, "run"):
            result = runner.run(name)
        elif hasattr(runner, "debate"):
            result = runner.debate(name)
        else:
            return _error(
                "DebateRunner exposes neither run() nor debate()",
                name=name,
            )
    except Exception as exc:
        return _error(f"debate failed: {exc}", name=name)

    if isinstance(result, dict):
        result.setdefault("ok", True)
        return result
    return _ok(result=result)


def loki_magic_tokens_extract() -> Dict[str, Any]:
    """Extract design tokens from the current codebase.

    Returns observed colors, spacing, typography, etc. Observation is
    non-destructive: the registry is not modified (save=False).
    """
    try:
        from magic.core.design_tokens import DesignTokens  # type: ignore
    except ImportError:
        return _run_loki(["magic", "tokens", "extract", "--json"])
    except Exception as exc:
        return _error(f"failed to import design tokens module: {exc}")

    try:
        dt = DesignTokens(".")
        observed = dt.extract_from_codebase(save=False)
    except Exception as exc:
        return _error(f"token extraction failed: {exc}")

    if isinstance(observed, dict):
        observed.setdefault("ok", True)
        return observed
    return _ok(tokens=observed)


def loki_magic_stats() -> Dict[str, Any]:
    """Registry stats: total components, per-target counts, debate pass rate.

    Returns:
        A dict of statistics on success, or a structured error dict on
        failure.
    """
    try:
        from magic.core.registry import ComponentRegistry  # type: ignore
    except ImportError:
        return _run_loki(["magic", "stats", "--json"])
    except Exception as exc:
        return _error(f"failed to import magic registry: {exc}")

    try:
        stats = ComponentRegistry(".").stats()
    except Exception as exc:
        return _error(f"failed to compute stats: {exc}")

    if isinstance(stats, dict):
        stats.setdefault("ok", True)
        return stats
    return _ok(stats=stats)


# ---------------------------------------------------------------------------
# Public registration entry point
# ---------------------------------------------------------------------------


# Tuple of (callable, public-tool-name). Tool names are stable and match
# the CLI verbs so MCP clients can predict them.
_TOOLS = (
    (loki_magic_generate, "loki_magic_generate"),
    (loki_magic_list, "loki_magic_list"),
    (loki_magic_get, "loki_magic_get"),
    (loki_magic_update, "loki_magic_update"),
    (loki_magic_debate, "loki_magic_debate"),
    (loki_magic_tokens_extract, "loki_magic_tokens_extract"),
    (loki_magic_stats, "loki_magic_stats"),
)


def register_magic_tools(mcp_server: Any) -> List[str]:
    """Wire the module's functions into a FastMCP server instance.

    Usage from mcp/server.py:
        from mcp.magic_tools import register_magic_tools
        register_magic_tools(mcp)

    Args:
        mcp_server: A FastMCP-compatible server instance exposing a
            `.tool()` decorator factory.

    Returns:
        The list of tool names that were successfully registered.
    """
    if mcp_server is None:
        raise ValueError("mcp_server must not be None")

    if not hasattr(mcp_server, "tool"):
        raise TypeError(
            "mcp_server does not expose a .tool() method; "
            "expected a FastMCP-compatible instance"
        )

    registered: List[str] = []
    for func, tool_name in _TOOLS:
        try:
            mcp_server.tool()(func)
            registered.append(tool_name)
        except Exception:
            # Don't let a single bad registration break the rest. The
            # integration pass can inspect the returned list to confirm
            # which tools made it through.
            continue
    return registered


__all__ = [
    "loki_magic_generate",
    "loki_magic_list",
    "loki_magic_get",
    "loki_magic_update",
    "loki_magic_debate",
    "loki_magic_tokens_extract",
    "loki_magic_stats",
    "register_magic_tools",
]
