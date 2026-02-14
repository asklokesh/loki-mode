#!/usr/bin/env python3
"""Context window tracker for Loki Mode.

Parses provider session files to extract token usage data
and writes tracking information to .loki/context/tracking.json.

Provider-agnostic: supports Claude, Codex, and Gemini CLIs.
- Claude: parses session JSONL from ~/.claude/projects/
- Codex/Gemini: accepts token data via --tokens-input/--tokens-output CLI args
- All providers: can accept --session-file to specify session file directly

Called by run.sh after each RARV iteration.

Usage:
    python3 context-tracker.py --iteration N --loki-dir .loki [--window-size 200000]
    python3 context-tracker.py --iteration N --loki-dir .loki --provider codex \
        --tokens-input 5000 --tokens-output 2000
    python3 context-tracker.py --iteration N --loki-dir .loki --session-file /path/to/session.jsonl
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


# Default pricing (USD per million tokens) - provider-specific overrides below
PRICING_BY_PROVIDER = {
    "claude": {
        "input": 3.0,
        "output": 15.0,
        "cache_read": 0.30,
        "cache_creation": 3.75,
    },
    "codex": {
        "input": 2.0,
        "output": 8.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
    "gemini": {
        "input": 1.25,
        "output": 5.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
}

# Default context window sizes per provider
WINDOW_SIZES = {
    "claude": 200000,
    "codex": 200000,
    "gemini": 1000000,
}


def get_pricing(provider):
    """Get pricing for a provider, falling back to Claude pricing."""
    return PRICING_BY_PROVIDER.get(provider, PRICING_BY_PROVIDER["claude"])


def derive_project_slug():
    """Derive Claude's project slug from cwd (matches Claude's naming convention)."""
    cwd = os.getcwd()
    # Claude uses: /Users/name/project -> -Users-name-project
    return "-" + cwd.lstrip("/").replace("/", "-")


def find_session_file(provider, session_file_arg=None):
    """Find the most recently modified session file for the given provider.

    Args:
        provider: 'claude', 'codex', or 'gemini'
        session_file_arg: explicit path from --session-file flag

    Returns:
        Path to session file or None
    """
    # Explicit path takes priority
    if session_file_arg:
        path = Path(session_file_arg)
        return path if path.exists() else None

    if provider == "claude":
        project_slug = derive_project_slug()
        session_dir = Path.home() / ".claude" / "projects" / project_slug
        if not session_dir.is_dir():
            return None
        jsonl_files = sorted(session_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        return jsonl_files[0] if jsonl_files else None

    # For codex/gemini, no standard session file location yet
    # They rely on --tokens-input/--tokens-output args instead
    return None


def calculate_cost(input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, provider="claude"):
    """Calculate estimated cost in USD using provider-specific pricing."""
    pricing = get_pricing(provider)
    cost = (
        (input_tokens / 1_000_000) * pricing["input"]
        + (output_tokens / 1_000_000) * pricing["output"]
        + (cache_read_tokens / 1_000_000) * pricing["cache_read"]
        + (cache_creation_tokens / 1_000_000) * pricing["cache_creation"]
    )
    return round(cost, 4)


def parse_session(jsonl_path, last_offset, iteration, window_size):
    """Parse session JSONL from last_offset, return new token data."""
    entries = []
    compactions = []
    current_line = 0

    # Running totals for this parse batch
    batch_input = 0
    batch_output = 0
    batch_cache_read = 0
    batch_cache_creation = 0

    # Track latest cumulative usage (last assistant message has running total for that API call)
    latest_input = 0
    latest_output = 0
    latest_cache_read = 0
    latest_cache_creation = 0

    with open(jsonl_path, "r") as f:
        for line_num, line in enumerate(f):
            if line_num < last_offset:
                continue

            line = line.strip()
            if not line:
                continue

            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            entry_type = entry.get("type", "")

            # Detect compaction: user message with context continuation summary
            if entry_type == "user":
                content = entry.get("message", {}).get("content", "")
                if isinstance(content, str) and "being continued from a previous conversation that ran out of context" in content:
                    compactions.append({
                        "at_iteration": iteration,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "tokens_before": latest_input + latest_cache_read,
                        "line": line_num,
                    })

            # Extract token usage from assistant messages
            if entry_type == "assistant":
                usage = entry.get("message", {}).get("usage", {})
                if usage:
                    inp = usage.get("input_tokens", 0)
                    out = usage.get("output_tokens", 0)
                    cache_read = usage.get("cache_read_input_tokens", 0)
                    cache_create = usage.get("cache_creation_input_tokens", 0)

                    batch_input += inp
                    batch_output += out
                    batch_cache_read += cache_read
                    batch_cache_creation += cache_create

                    # Track latest for context window percentage
                    latest_input = inp
                    latest_cache_read = cache_read

            current_line = line_num + 1

    return {
        "batch_input": batch_input,
        "batch_output": batch_output,
        "batch_cache_read": batch_cache_read,
        "batch_cache_creation": batch_cache_creation,
        "latest_input": latest_input,
        "latest_cache_read": latest_cache_read,
        "compactions": compactions,
        "new_offset": current_line,
    }


def update_tracking(loki_dir, iteration, window_size, provider="claude",
                    session_file=None, direct_tokens=None):
    """Main tracking function - parse session and update tracking.json.

    Args:
        loki_dir: Path to .loki directory
        iteration: Current RARV iteration number
        window_size: Context window size in tokens
        provider: Provider name (claude, codex, gemini)
        session_file: Explicit path to session file (optional)
        direct_tokens: Dict with input/output token counts for non-Claude providers
    """
    context_dir = Path(loki_dir) / "context"
    context_dir.mkdir(parents=True, exist_ok=True)

    tracking_file = context_dir / "tracking.json"
    offset_file = context_dir / "last_offset.txt"

    # Load existing tracking data
    tracking = {
        "session_id": "",
        "provider": provider,
        "updated_at": "",
        "current": {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "total_tokens": 0,
            "context_window_pct": 0.0,
            "estimated_cost_usd": 0.0,
        },
        "compactions": [],
        "per_iteration": [],
        "totals": {
            "total_input": 0,
            "total_output": 0,
            "total_cost_usd": 0.0,
            "compaction_count": 0,
            "iterations_tracked": 0,
        },
    }

    if tracking_file.exists():
        try:
            tracking = json.loads(tracking_file.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    # Ensure provider field is current
    tracking["provider"] = provider

    # For non-Claude providers with direct token args, skip session parsing
    if direct_tokens:
        result = {
            "batch_input": direct_tokens.get("input", 0),
            "batch_output": direct_tokens.get("output", 0),
            "batch_cache_read": 0,
            "batch_cache_creation": 0,
            "latest_input": direct_tokens.get("input", 0),
            "latest_cache_read": 0,
            "compactions": [],
            "new_offset": 0,
        }
        tracking["session_id"] = f"{provider}-direct"
        tracking["updated_at"] = datetime.now(timezone.utc).isoformat()
    else:
        # Read last offset
        last_offset = 0
        if offset_file.exists():
            try:
                last_offset = int(offset_file.read_text().strip())
            except (ValueError, OSError):
                pass

        # Find session file
        jsonl_path = find_session_file(provider, session_file)
        if not jsonl_path:
            return

        # Parse new entries
        result = parse_session(jsonl_path, last_offset, iteration, window_size)

        if result["new_offset"] == last_offset:
            return  # Nothing new

        # Update session ID and offset
        tracking["session_id"] = jsonl_path.stem
        tracking["updated_at"] = datetime.now(timezone.utc).isoformat()
        offset_file.write_text(str(result["new_offset"]))

    # Calculate iteration cost
    iter_cost = calculate_cost(
        result["batch_input"],
        result["batch_output"],
        result["batch_cache_read"],
        result["batch_cache_creation"],
        provider,
    )

    # Add per-iteration entry
    # Check if iteration already exists (avoid duplicates on retry)
    existing_iters = {e["iteration"] for e in tracking["per_iteration"]}
    if iteration not in existing_iters:
        tracking["per_iteration"].append({
            "iteration": iteration,
            "input_tokens": result["batch_input"],
            "output_tokens": result["batch_output"],
            "cache_read_tokens": result["batch_cache_read"],
            "cache_creation_tokens": result["batch_cache_creation"],
            "cost_usd": iter_cost,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "compacted": len(result["compactions"]) > 0,
        })

    # Add new compactions
    tracking["compactions"].extend(result["compactions"])

    # Update totals
    tracking["totals"]["total_input"] += result["batch_input"]
    tracking["totals"]["total_output"] += result["batch_output"]
    tracking["totals"]["total_cost_usd"] = round(
        tracking["totals"]["total_cost_usd"] + iter_cost, 4
    )
    tracking["totals"]["compaction_count"] = len(tracking["compactions"])
    tracking["totals"]["iterations_tracked"] = len(tracking["per_iteration"])

    # Update current snapshot
    # Context window % is based on the latest API call's input tokens
    # (which represents what's currently in the context window)
    context_tokens = result["latest_input"] + result["latest_cache_read"]
    tracking["current"] = {
        "input_tokens": result["latest_input"],
        "output_tokens": result["batch_output"],
        "cache_read_tokens": result["latest_cache_read"],
        "cache_creation_tokens": result["batch_cache_creation"],
        "total_tokens": context_tokens,
        "context_window_pct": round((context_tokens / window_size) * 100, 2) if window_size > 0 else 0,
        "estimated_cost_usd": tracking["totals"]["total_cost_usd"],
    }

    # Write tracking file atomically
    tmp_file = tracking_file.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(tracking, indent=2))
    tmp_file.rename(tracking_file)


def main():
    parser = argparse.ArgumentParser(description="Track context window usage for Loki Mode")
    parser.add_argument("--iteration", type=int, required=True, help="Current RARV iteration number")
    parser.add_argument("--loki-dir", default=".loki", help="Path to .loki directory")
    parser.add_argument("--window-size", type=int, default=0,
                        help="Context window size in tokens (0 = auto-detect from provider)")
    parser.add_argument("--provider", default="claude", choices=["claude", "codex", "gemini"],
                        help="LLM provider (claude, codex, gemini)")
    parser.add_argument("--session-file", default=None,
                        help="Explicit path to session file (overrides auto-detection)")
    parser.add_argument("--tokens-input", type=int, default=0,
                        help="Direct input token count (for non-Claude providers)")
    parser.add_argument("--tokens-output", type=int, default=0,
                        help="Direct output token count (for non-Claude providers)")
    args = parser.parse_args()

    # Auto-detect window size from provider if not specified
    window_size = args.window_size if args.window_size > 0 else WINDOW_SIZES.get(args.provider, 200000)

    # Build direct tokens dict if provided
    direct_tokens = None
    if args.tokens_input > 0 or args.tokens_output > 0:
        direct_tokens = {"input": args.tokens_input, "output": args.tokens_output}

    update_tracking(args.loki_dir, args.iteration, window_size,
                    provider=args.provider, session_file=args.session_file,
                    direct_tokens=direct_tokens)


if __name__ == "__main__":
    main()
