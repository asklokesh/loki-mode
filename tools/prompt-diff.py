#!/usr/bin/env python3
"""Show exactly what LOKI_SIMPLE=1 deletes from the prompt, before anyone
trusts an ablation result built on it.

The flag strips the coaching half of the system prompt (measured -78%, roughly
1562 tokens per iteration). A percentage is not a reason to believe an arm is
sound. WHICH instructions vanished is, and nothing printed that until now: the
ablation tests assert that named anchors are absent, which proves the strip
happened, not that what it took was safe to take.

THE ONE ASSERTION THIS FILE EXISTS FOR, and the reason it can exit 1:

    the dynamic tail must be IDENTICAL between the two arms.

Everything above [CACHE_BREAKPOINT] is the cache-stable prefix -- coaching,
which is how to work, and which a frontier model does natively. Everything
below is per-iteration STATE: which gate failed, what self-heal found, what
iteration this is. The model cannot derive state. An arm that drops coaching is
an experiment about prompt bloat; an arm that drops state is a run going blind
to its own history, and the two are indistinguishable from a byte count alone.

WHY THE STRIP IS SIMULATED DOCUMENT-WIDE. The removal predicate is applied to
EVERY line of the fixture, then both arms are split at the marker and the tails
compared. Applying it only above the marker and copying the tail verbatim would
compare the tail to itself, and the most important check in this file could
never fail. Simulating the whole document means a predicate that drifts into
matching tail content produces a real FAIL, which is the point.

The anchors are derived from the nine values pushed inside `if (!simple)` at
loki-ts/src/runner/build_prompt.ts:1607-1617. Two prefix lines pushed just
AFTER that block are deliberately absent: goal-sharpening and
CODEBASE_ANALYSIS_MODE survive the flag, and listing them here would
over-report the deletion. A stale anchor under-reports it, so an anchor that
matches nothing anywhere in the corpus is reported loudly rather than ignored.

Honesty rules, same as tools/receipt-diff.py: an unmeasured value reads
UNKNOWN, never 0; a fixture that cannot be split is reported as NOT CHECKED
rather than silently skipped; and tokens are labelled as the bytes/4 estimate
they are, because printing a bare integer would dress a derivation up as a
measurement.
"""

import argparse
import json
import os
import sys

UNKNOWN = "UNKNOWN"
MARKER = "[CACHE_BREAKPOINT]"

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CORPUS = os.path.join(
    os.path.dirname(_HERE), "loki-ts", "tests", "fixtures", "build_prompt")

# The nine coaching values gated by `if (!simple)` in build_prompt.ts. Each is a
# whole-line, start-anchored prefix: a bare substring would match this file's
# own prose and any tail line quoting an instruction back.
STRIP_ANCHORS = (
    "RALPH WIGGUM MODE ACTIVE.",                 # rarvText
    "SDLC_PHASES_ENABLED: [",                    # sdlcText
    "CRITICAL AUTONOMY RULES: ",                 # autonomyText
    "MEMORY SYSTEM: ",                           # MEMORY_INSTRUCTION
    "USAGE_DOC_REQUIRED: ",                      # USAGE_DOC_INSTRUCTION
    "DOC_SCOPE: ",                               # docScope
    "RUN_CONTRACT: ",                            # COMPOSE_INSTRUCTION
    "LSP_GROUNDING: ",                           # LSP_GROUNDING_INSTRUCTION
    "Project conventions: read AGENTS.md",       # AGENTS_MD_INSTRUCTION
)


class UsageError(Exception):
    """Raised for a malformed invocation, so main() can exit 64."""


def _num(v):
    """A number as itself, anything else (None, "", bool) as None.

    Lifted verbatim from tools/receipt-diff.py rather than re-derived: an
    absent value must never arrive downstream as a real 0.
    """
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def is_coaching(line):
    """True when LOKI_SIMPLE=1 would delete this line.

    Start-anchored on purpose. Substring matching would let a tail line that
    mentions an instruction be scored as coaching, which is exactly the
    misclassification the tail check is supposed to catch.
    """
    return any(line.startswith(a) for a in STRIP_ANCHORS)


def simulate(text):
    """The simple arm: apply the strip to the WHOLE document, not the prefix.

    Returns (kept_lines, removed_lines).
    """
    kept, removed = [], []
    for line in text.split("\n"):
        (removed if is_coaching(line) else kept).append(line)
    return kept, removed


def split_at_marker(text):
    """(prefix, tail) around the literal marker, or None when absent."""
    if MARKER not in text:
        return None
    prefix, tail = text.split(MARKER, 1)
    return prefix, tail


def est_tokens(n_bytes):
    """The repo's own bytes/4 estimator, never presented as a measurement."""
    b = _num(n_bytes)
    return None if b is None else int(round(b / 4.0))


def is_degraded(fixture_dir):
    """True when this fixture takes the degraded-provider path.

    LOAD-BEARING, and invisible to a text-only reading of expected.txt. On
    PROVIDER_DEGRADED=true, buildPrompt returns buildStaticFirstDegraded at
    build_prompt.ts:1574-1577 -- BEFORE `const simple` is even read at 1606 and
    before the `if (!simple)` gate at 1607. The flag is inert there: both arms
    emit identical bytes (verified against the real builder, 4202 == 4202,
    against 7900 -> 1653 on the normal path).

    Without this, the tool matches coaching-shaped anchors in a degraded
    prompt and reports a saving the flag cannot produce -- a fabricated
    number attached to the one thing a human reads this tool to learn.
    """
    env_path = os.path.join(fixture_dir, "env.txt") if fixture_dir else None
    if not env_path or not os.path.isfile(env_path):
        return False
    with open(env_path, "r", encoding="utf-8") as fh:
        return any(line.strip() == "PROVIDER_DEGRADED=true" for line in fh)


def analyze(name, text, fixture_dir=None):
    """Diff one fixture's two arms. Never raises on shape; reports instead."""
    full_bytes = len(text.encode("utf-8"))

    if is_degraded(fixture_dir):
        # A MEASURED zero, not an unmeasured one: the arms were compared and
        # found equal. Reported, never folded into NOT CHECKED -- this fixture
        # is perfectly checkable and the answer is "the flag does nothing".
        split = split_at_marker(text)
        tail_lines = ([ln for ln in split[1].split("\n") if ln.strip()]
                      if split else [])
        return {
            "fixture": name,
            "checked": split is not None,
            "degraded": True,
            "why": "degraded provider path returns before the LOKI_SIMPLE "
                   "gate, so the flag has no effect here",
            "full_bytes": full_bytes,
            "simple_bytes": full_bytes,
            "removed": [],
            "survived": [ln for ln in (split[0] if split else text).split("\n")
                         if ln.strip()],
            "tail_lines": tail_lines,
            "tail_identical": True if split is not None else None,
            "tail_diff": None,
        }

    split_full = split_at_marker(text)
    if split_full is None:
        return {
            "fixture": name,
            "checked": False,
            "degraded": False,
            "why": "no %s marker, so prefix and tail cannot be separated "
                   "(legacy flat prompt ordering)" % MARKER,
            "full_bytes": full_bytes,
            "simple_bytes": None,
            "removed": [],
            "survived": [],
            "tail_identical": None,
        }

    kept, removed = simulate(text)
    simple_text = "\n".join(kept)
    split_simple = split_at_marker(simple_text)

    # The strip eating the marker itself would be the most severe form of the
    # failure this file guards, so it is a FAIL and not a "cannot check".
    if split_simple is None:
        return {
            "fixture": name,
            "checked": True,
            "degraded": False,
            "tail_identical": False,
            "why": "the simulated strip removed the %s marker itself" % MARKER,
            "full_bytes": full_bytes,
            "simple_bytes": len(simple_text.encode("utf-8")),
            "removed": removed,
            "survived": [],
            "tail_diff": None,
        }

    tail_full, tail_simple = split_full[1], split_simple[1]
    identical = tail_full == tail_simple

    prefix_simple = split_simple[0]
    survived = [ln for ln in prefix_simple.split("\n") if ln.strip()]

    out = {
        "fixture": name,
        "checked": True,
        "degraded": False,
        "tail_identical": identical,
        "full_bytes": full_bytes,
        "simple_bytes": len(simple_text.encode("utf-8")),
        "removed": removed,
        "survived": survived,
        "tail_lines": [ln for ln in tail_full.split("\n") if ln.strip()],
        "tail_diff": None,
    }
    if not identical:
        out["tail_diff"] = _first_divergence(tail_full, tail_simple)
    return out


def _first_divergence(a, b):
    """The first differing tail line, so a FAIL names what went missing."""
    la, lb = a.split("\n"), b.split("\n")
    for i in range(max(len(la), len(lb))):
        x = la[i] if i < len(la) else None
        y = lb[i] if i < len(lb) else None
        if x != y:
            return {"line": i + 1, "full": x, "simple": y}
    return None


def scan(corpus):
    """Every fixture under the corpus root, in stable lexicographic order."""
    if not os.path.isdir(corpus):
        return None
    results = []
    for entry in sorted(os.listdir(corpus)):
        fixture_dir = os.path.join(corpus, entry)
        path = os.path.join(fixture_dir, "expected.txt")
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                results.append(analyze(entry, fh.read(), fixture_dir))
    return results


def unused_anchors(results):
    """Anchors matching nothing anywhere: a silent under-report of the strip."""
    seen = set()
    for r in results:
        for line in r["removed"]:
            for a in STRIP_ANCHORS:
                if line.startswith(a):
                    seen.add(a)
    return [a for a in STRIP_ANCHORS if a not in seen]


def _delta_line(full_b, simple_b):
    fb, sb = _num(full_b), _num(simple_b)
    if fb is None or sb is None:
        return "bytes %s -> %s   delta %s" % (
            fb if fb is not None else UNKNOWN,
            sb if sb is not None else UNKNOWN, UNKNOWN)
    d = sb - fb
    pct = (100.0 * d / fb) if fb else None
    tok = est_tokens(-d)
    return ("bytes %d -> %d   delta %+d (%s), ~%s tokens saved "
            "(est., bytes/4)" % (
                fb, sb, d,
                "%+.1f%%" % pct if pct is not None else UNKNOWN,
                tok if tok is not None else UNKNOWN))


def _abbrev(line, width=96):
    line = line.rstrip()
    return line if len(line) <= width else line[:width - 3] + "..."


def render(results, corpus, verbose=False):
    lines = ["LOKI_SIMPLE=1 prompt ablation diff",
             "  corpus: %s" % corpus,
             "  arms:   full (default) vs simple (LOKI_SIMPLE=1)", ""]

    checked = [r for r in results if r["checked"]]
    failed = [r for r in checked if r["tail_identical"] is False]
    skipped = [r for r in results if not r["checked"]]

    for r in results:
        if not r["checked"]:
            continue
        # A degraded fixture has nothing removed BECAUSE the flag is inert
        # there, which is a finding. Hiding it would leave a reader believing
        # the corpus is uniform.
        if (not verbose and not r["removed"] and r["tail_identical"]
                and not r.get("degraded")):
            continue
        lines.append("  %s" % r["fixture"])
        lines.append("    %s" % _delta_line(r["full_bytes"], r["simple_bytes"]))
        if r["removed"]:
            lines.append("    REMOVED under the flag (coaching, %d lines):"
                         % len(r["removed"]))
            for line in r["removed"]:
                lines.append("      - %s" % _abbrev(line))
        elif r.get("degraded"):
            lines.append("    REMOVED under the flag: NOTHING -- %s"
                         % r.get("why"))
        else:
            lines.append("    REMOVED under the flag: nothing (this prompt "
                         "carries no coaching to strip)")
        lines.append("    SURVIVES in the prefix (%d lines):"
                     % len(r["survived"]))
        for line in r["survived"]:
            lines.append("      + %s" % _abbrev(line))
        tail_n = len(r.get("tail_lines") or [])
        if r["tail_identical"]:
            lines.append("    SURVIVES in the dynamic tail: all %d lines, "
                         "byte-identical between arms" % tail_n)
        else:
            lines.append("    FAIL  the dynamic tail DIFFERS between arms: %s"
                         % (r.get("why") or "state was deleted, not coaching"))
            d = r.get("tail_diff")
            if d:
                lines.append("      tail line %d" % d["line"])
                lines.append("        full:   %s" % _abbrev(str(d["full"])))
                lines.append("        simple: %s" % _abbrev(str(d["simple"])))
        lines.append("")

    if skipped:
        lines.append("  NOT CHECKED: %d fixture(s) (reported, not skipped):"
                     % len(skipped))
        for r in skipped:
            lines.append("    %s: %s" % (r["fixture"], r["why"]))
        lines.append("")

    stale = unused_anchors(checked)
    if stale:
        lines.append("  WARNING: %d strip anchor(s) matched nothing in the "
                     "whole corpus, so this tool may be UNDER-reporting what "
                     "the flag deletes:" % len(stale))
        for a in stale:
            lines.append("    %s" % a)
        lines.append("")

    degraded = [r for r in results if r.get("degraded")]
    if degraded:
        lines.append("  FLAG INERT on %d degraded-provider fixture(s) "
                     "(measured 0-byte delta, not an unmeasured one): %s"
                     % (len(degraded), ", ".join(r["fixture"]
                                                 for r in degraded)))
        lines.append("")

    lines.append("  %d fixture(s) scanned, %d checked, %d not checked"
                 % (len(results), len(checked), len(skipped)))
    if failed:
        for r in failed:
            lines.append("  FAIL  %s: dynamic tail is NOT identical between "
                         "arms" % r["fixture"])
        lines.append("VERDICT: FAIL -- %d fixture(s) would lose STATE, not "
                     "coaching. That is not an ablation, it is the run going "
                     "blind to its own history." % len(failed))
    else:
        lines.append("VERDICT: PASS -- the dynamic tail is byte-identical "
                     "between arms in all %d checked fixture(s); only prefix "
                     "coaching is removed." % len(checked))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Show what LOKI_SIMPLE=1 removes from the prompt, and "
                    "assert the dynamic tail is identical between arms.")

    def _usage_error(message):
        raise UsageError(message)

    # argparse exits 2 for a usage error, which in this tool line means
    # "could NOT check" -- a materially different claim from "you typed it
    # wrong". Reroute to 64. --help is unaffected: it goes through
    # parser.exit(0), not error().
    ap.error = _usage_error

    ap.add_argument("corpus", nargs="?", default=DEFAULT_CORPUS,
                    help="build_prompt fixture corpus root "
                         "(default: %s)" % DEFAULT_CORPUS)
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the diff as JSON")
    ap.add_argument("--verbose", action="store_true",
                    help="include fixtures with nothing removed")

    try:
        args = ap.parse_args(argv)
    except UsageError as exc:
        sys.stderr.write("usage error: %s\n" % exc)
        return 64

    if not os.path.isdir(args.corpus):
        payload = {"checked": False,
                   "reason": "fixture corpus not found: %s" % args.corpus}
        print(json.dumps(payload, indent=2) if args.as_json
              else "INPUT MISSING: fixture corpus not found: %s" % args.corpus)
        return 66

    results = scan(args.corpus)

    # An empty diff must never read as "no changes"; there was nothing to read.
    if not results:
        payload = {"checked": False, "fixtures": 0,
                   "reason": "no fixture-*/expected.txt under %s" % args.corpus}
        print(json.dumps(payload, indent=2) if args.as_json
              else "NOTHING TO COMPARE: no fixture-*/expected.txt under %s"
                   % args.corpus)
        return 3

    checked = [r for r in results if r["checked"]]
    if not checked:
        payload = {"checked": False, "fixtures": len(results),
                   "reason": "no fixture carries the %s marker, so no arm "
                             "could be split" % MARKER}
        print(json.dumps(payload, indent=2) if args.as_json
              else "CANNOT CHECK: no fixture carries the %s marker, so no "
                   "prefix/tail split was possible" % MARKER)
        return 2

    failed = [r for r in checked if r["tail_identical"] is False]

    if args.as_json:
        print(json.dumps({
            "corpus": args.corpus,
            "fixtures": len(results),
            "checked": len(checked),
            "not_checked": len(results) - len(checked),
            "tail_failures": [r["fixture"] for r in failed],
            "stale_anchors": unused_anchors(checked),
            "results": results,
        }, indent=2))
    else:
        print(render(results, args.corpus, verbose=args.verbose))

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
