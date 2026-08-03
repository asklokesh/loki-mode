#!/usr/bin/env python3
"""Rank system-prompt instruction blocks by how much they look like dead weight.

WHY THIS EXISTS. Anthropic deleted roughly 80% of Claude Code's system prompt
for Opus 5. The deleted text was not wrong; it was written to correct behaviours
of OLDER models that a newer one no longer needs. Coaching a capable model
through a procedure it already runs natively costs tokens on EVERY iteration and
buys nothing. Our prompt has the same shape and has never been pruned.

Pruning by intuition is how you delete the one line that was load-bearing. So
this does not prune. It RANKS, so a human can spend an ablation trial on the
highest-value candidate first instead of the first block they happened to read.

WHAT IS READ, and where the line is drawn. The corpus is the byte-exact
build_prompt fixtures. Each expected.txt splits at the literal
`[CACHE_BREAKPOINT]` marker:

  ABOVE it  the cache-stable prefix: standing instructions, sent every
            iteration, identical every iteration. This is the coaching half and
            the only half this tool scores.
  BELOW it  `<dynamic_context>`: iteration number, retry count, live state.
            Per-iteration FACTS the model cannot infer. Never scored, never
            flagged, not even read.

A fixture with no marker has no such split to read. It is EXCLUDED and counted,
never treated as all-prefix -- fixture-30's first line is "Resume iteration #3
(retry #1)", which is state, and scoring it would flag exactly the thing this
tool must never flag. Exclusions are printed with the run, because an exclusion
nobody can see is one nobody can challenge.

DEDUPE, which decides whether the output is usable. 58 fixtures carry a prefix
but they hold only 39 DISTINCT lines: the RALPH WIGGUM block alone recurs seven
times at near-identical size. Ranked per occurrence, the entire top of the
report is seven copies of one block and a reader cannot find the second
candidate. So blocks are deduped on exact text and carry an OCCURRENCES count.
That count is also the honest measure of reclaim: a block in 46 of 58 prompts is
worth more to delete than one appearing once.

Dedupe is on the text with RUNTIME-SUBSTITUTED NUMBERS masked, and that detail
was not a guess. Exact-string dedupe was tried first and produced SEVEN distinct
RALPH WIGGUM entries occupying ranks 3 through 6 of the report. The variants
differ at byte 533 by a single character: `MAX_PARALLEL_AGENTS=10` against `=12`
-- one interpolated value, not one authored instruction. A reader cannot run an
ablation on "the =10 variant". Masking digit runs collapses them to one entry
carrying the summed occurrence count, which is what a human actually deletes.

Masking is deliberately limited to digits, and the limit is load-bearing in
BOTH directions. Two RALPH WIGGUM rows survive the mask, and they should: they
carry OPPOSITE completion instructions -- "There is NEVER a 'finished' state"
against "claim done via loki_complete_task and STOP". Collapsing those would
hide a real fork in the prompt behind whichever variant happened to be seen
first. Blocks differing by an SDLC phase LIST (`[UNIT_TESTS]` against
`[UNIT_TESTS,API_TESTS]`) stay separate for the same reason. Anything beyond
digit masking would need a similarity threshold, which is a tuning knob and a
new way to be wrong.

SCORING is a transparent sum of named signals, and every matched signal name is
printed. A ranking whose reasons are invisible is a ranking nobody can argue
with.

  UP    size (tokens reclaimed), and coaching shape: "you must", "always",
        "never", "make sure", numbered procedure steps, and naming a process a
        capable model already runs (reason, reflect, verify, iterate).
  DOWN  a concrete repo path, a file to write, a specific command, an exit
        criterion. Those carry information the model cannot infer, and deleting
        them removes a fact rather than a redundant instruction.

THE TENSION IS REAL, and it is why this is advisory rather than a gate. The
top-ranked block scores high on both directions at once: RALPH WIGGUM is large,
numbered, and names REASON/REFLECT/VERIFY -- and it also names
`.loki/CONTINUITY.md` and `.loki/state/`. It is coaching and information braided
together. No static analysis can say which half is carrying the run. Only a
measured ablation can, which is precisely what a ranking is for.

ADVISORY, NOT A VERDICT. A high score is a hypothesis to test, never a licence
to delete.

HONESTY. An unmeasured value prints UNKNOWN, never 0. No fixtures, or fixtures
with no scoreable block, exits 3 -- an empty ranking would read as "nothing to
delete", which is the opposite of "nobody looked".

Exit codes follow the tools/ convention:
  0  analysed, ranking emitted
  2  the scan itself could not run
  3  nothing to analyse (no fixtures, or none with a cache prefix)
  64 usage error
  66 the given fixture root does not exist

This is an ADVISOR: no gate consumes its exit code, and 0 means the question was
answered honestly. Reads the filesystem only. Starts nothing, spends nothing.

Usage:
  tools/prompt-lint.py [fixture-root] [--json] [--top N]
"""

import argparse
import json
import os
import re
import sys

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

# The byte-exact corpus. These fixtures gate build_prompt parity on both routes,
# so they are the closest thing to the real shipped prompt that can be read
# without running a build.
FIXTURE_GLOB = os.path.join("loki-ts", "tests", "fixtures", "build_prompt")

# The split literal. Everything above is cache-stable coaching; everything below
# is per-iteration state and is never read.
BREAKPOINT = "[CACHE_BREAKPOINT]"

# Structural scaffolding, not instructions. Scoring `<loki_system>` as a
# deletion candidate is noise: it is 13 bytes and it is a tag.
_SCAFFOLD = {"<loki_system>", "</loki_system>", "<dynamic_context>",
             "</dynamic_context>"}

# A line under this many bytes cannot repay an ablation trial even if deleted
# outright. Keeps "Loki Mode" (9 bytes) out of a ranking of things worth testing.
MIN_BLOCK_BYTES = 40

# Roughly 4 bytes per token for English prose. Deliberately crude and labelled
# as an estimate everywhere it is printed -- a precise tokeniser would imply a
# precision the ranking does not have and does not need.
BYTES_PER_TOKEN = 4

# Signals, each with a weight and a name that is printed when it fires. The
# names are the evidence line: a reader disagreeing with a rank can see exactly
# which cue produced it and argue with that cue rather than with the number.
#
# UP-weighted signals are shapes that coach a model through something. DOWN
# weights are negative because the text carries a fact instead: a path, a
# filename, a command, a condition for stopping. Deleting information is a
# different and worse trade than deleting redundant instruction.
_SIGNALS = (
    (re.compile(r"\byou must\b", re.I), 3, "imperative:you-must"),
    (re.compile(r"\b(?:ALWAYS|NEVER)\b"), 3, "imperative:always-never"),
    (re.compile(r"\bmake sure\b", re.I), 3, "imperative:make-sure"),
    (re.compile(r"\bdo not\b|\bdon't\b", re.I), 2, "imperative:prohibition"),
    (re.compile(r"\bCRITICAL\b|\bMUST\b|\bREQUIRED\b"), 2, "imperative:emphasis"),
    (re.compile(r"\b\d\)\s"), 4, "procedure:numbered-steps"),
    (re.compile(r"\b(?:REASON|REFLECT|VERIFY|ITERATE|ANALYZE|ANALYSE)\b", re.I),
     4, "native-capability:named-process"),
    (re.compile(r"\bstep\s+\d\b|\bfirst,|\bthen,|\bfinally,", re.I),
     2, "procedure:sequencing"),
    # DOWN. Information the model cannot infer from the task.
    (re.compile(r"\.loki/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.(?:md|json|ya?ml|toml|txt)"),
     -3, "information:concrete-path"),
    (re.compile(r"\bwrite\s+[A-Za-z0-9_.-]+\.(?:md|json|ya?ml)|\bcreate\s+\.loki/",
                re.I), -3, "information:file-to-write"),
    (re.compile(r"`[^`]+`|\b(?:npm|pip|docker|git|curl|bun|pytest|python3?)\s+"
                r"[a-z-]+"), -3, "information:specific-command"),
    (re.compile(r"\bmcp__[a-z_-]+|\bloki_[a-z_]+\b"), -3, "information:tool-name"),
    (re.compile(r"\bunder \d+ lines\b|\bkeep it under\b|\bmax(?:imum)? of \d+"
                r"|\blimit to\b|\bMAX_[A-Z_]+=", re.I),
     -3, "information:exit-criterion"),
)

# Runtime-substituted values. `MAX_PARALLEL_AGENTS=10` and `=12` are one
# authored instruction, and collapsing them is what keeps one block from taking
# four consecutive ranks. See the docstring: this was measured, not assumed.
_DIGITS = re.compile(r"\d+")


def dedupe_key(text):
    return _DIGITS.sub("#", text)


# Size contributes on a log-ish curve: a 1400-byte block should outrank a
# 200-byte one, but not by seven times, or size alone would decide the whole
# ranking and the signal names would be decoration.
def _size_points(nbytes):
    points = 0
    for threshold in (100, 250, 500, 1000, 2000, 4000):
        if nbytes >= threshold:
            points += 2
    return points


# A block sent in 42 of 58 prompts costs 42x what a block sent in one does, so
# the reclaim differs by that factor even at identical size. Kept as a small
# bounded bonus rather than a multiplier: multiplying would let a ubiquitous but
# information-dense block outrank a rarer block that is pure coaching, and
# frequency is a cost argument, not evidence the text is dead weight.
def _occurrence_points(count):
    points = 0
    for threshold in (2, 10, 30):
        if count >= threshold:
            points += 2
    return points


class ScanError(Exception):
    """The scan could not run. Exit 2, never a ranking."""


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error, and 2 already means something else.

    In this convention 2 is "could NOT analyse" -- a real answer about the
    corpus. A typo in a flag is not that; it is 64. Left alone, `--tpo` would
    report as a failed scan and a CI job could not tell the two apart.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def find_fixtures(root):
    """Every fixture-*/expected.txt under root, sorted for stable output."""
    out = []
    if not os.path.isdir(root):
        return out
    for name in sorted(os.listdir(root)):
        if not name.startswith("fixture-"):
            continue
        full = os.path.join(root, name, "expected.txt")
        if os.path.isfile(full):
            out.append((name, full))
    return out


def static_prefix(text):
    """Everything ABOVE the breakpoint, or None when there is no split.

    None is not an empty prefix. It means this fixture cannot be read at all --
    the caller must EXCLUDE it, never fall back to scoring the whole file, which
    would score per-iteration state as coaching.
    """
    idx = text.find(BREAKPOINT)
    if idx < 0:
        return None
    return text[:idx]


def split_blocks(prefix):
    """One instruction block per non-empty, non-scaffold, non-trivial line."""
    blocks = []
    for line in prefix.splitlines():
        line = line.strip()
        if not line or line in _SCAFFOLD:
            continue
        if len(line.encode("utf-8")) < MIN_BLOCK_BYTES:
            continue
        blocks.append(line)
    return blocks


def score_block(text, occurrences=1):
    """Sum of size, frequency and named signal weights.

    Returns (score, reasons). Every contributing term is named in reasons: a
    rank whose reasons are invisible is one nobody can argue with.
    """
    nbytes = len(text.encode("utf-8"))
    size = _size_points(nbytes)
    freq = _occurrence_points(occurrences)
    reasons = []
    if size:
        reasons.append("size:+%d" % size)
    if freq:
        reasons.append("frequency(x%d):+%d" % (occurrences, freq))
    total = size + freq
    for pattern, weight, label in _SIGNALS:
        if pattern.search(text):
            total += weight
            reasons.append("%s:%+d" % (label, weight))
    return total, reasons


def analyse(root):
    """Dedupe blocks across fixtures, score each once, rank by score.

    Deduped on EXACT text with an occurrence count. Ranking per occurrence puts
    seven copies of the same block at the top and hides every other candidate.
    """
    fixtures = find_fixtures(root)
    if not fixtures:
        raise ScanError("no fixture-*/expected.txt found under " + root)

    excluded = []
    seen = {}
    order = []
    prefixed = 0
    for name, full in fixtures:
        try:
            text = _read(full)
        except OSError as exc:
            excluded.append((name, "unreadable: %s" % exc))
            continue
        prefix = static_prefix(text)
        if prefix is None:
            excluded.append(
                (name, "no %s; no static/volatile split to read" % BREAKPOINT))
            continue
        prefixed += 1
        for block in split_blocks(prefix):
            key = dedupe_key(block)
            if key not in seen:
                # First text seen for this key is the printed representative.
                # The variants differ only in a substituted number, so any one
                # of them describes the block a human would actually delete.
                seen[key] = [0, block]
                order.append(key)
            seen[key][0] += 1

    ranked = []
    for key in order:
        count, block = seen[key]
        nbytes = len(block.encode("utf-8"))
        score, reasons = score_block(block, count)
        ranked.append({
            "text": block,
            "bytes": nbytes,
            "est_tokens": nbytes // BYTES_PER_TOKEN,
            "occurrences": count,
            "score": score,
            "signals": reasons,
        })
    # Score first, then size, then text -- so the order is total and two runs
    # over the same corpus cannot disagree.
    ranked.sort(key=lambda b: (-b["score"], -b["bytes"], b["text"]))
    return {
        "fixtures_found": len(fixtures),
        "fixtures_with_prefix": prefixed,
        "fixtures_excluded": [{"fixture": n, "reason": r} for n, r in excluded],
        "blocks_analyzed": len(ranked),
        "blocks": ranked,
    }


ADVISORY = ("ADVISORY: this ranks deletion CANDIDATES, it does not decide. "
            "A high score is a hypothesis to test with a measured ablation "
            "trial, never a licence to delete.")


def _exit_code(report):
    if not report["blocks_analyzed"]:
        return 3
    return 0


def _render(report, code, top):
    lines = ["PROMPT LINT -- deletion candidates in the cache-stable prefix"]
    lines.append("  " + ADVISORY)
    lines.append("")
    lines.append("  fixtures found:      %d" % report["fixtures_found"])
    lines.append("  with cache prefix:   %d" % report["fixtures_with_prefix"])
    lines.append("  distinct blocks:     %d" % report["blocks_analyzed"])

    # NOT "tokens per prompt" and NOT "tokens across the corpus". It is the sum
    # over DISTINCT blocks: no single prompt carries all of them, and a block
    # sent 48 times counts once. Labelled for exactly what it measures, because
    # a reader sizing an ablation will quote this number.
    distinct = sum(b["est_tokens"] for b in report["blocks"])
    lines.append("  distinct coaching tokens: %s  (deduped, NOT per-prompt; "
                 "bytes/%d, an estimate)"
                 % (distinct if report["blocks"] else "UNKNOWN",
                    BYTES_PER_TOKEN))
    lines.append("  per-prompt reclaim: see the x<N> prompts column per block")
    lines.append("  measured deletion value: UNKNOWN -- requires an ablation "
                 "trial; this tool ranks only")

    for item in report["fixtures_excluded"]:
        lines.append("  excluded: %-14s %s" % (item["fixture"], item["reason"]))

    if code == 3:
        lines.append("")
        lines.append("NOTHING TO ANALYZE -- no block found in any cache "
                     "prefix. This is an absent measurement, not a finding "
                     "that the prompt is already lean.")
        return "\n".join(lines)

    shown = report["blocks"][:top]
    lines.append("")
    lines.append("RANKED DELETION CANDIDATES (top %d of %d)"
                 % (len(shown), report["blocks_analyzed"]))
    for rank, b in enumerate(shown, 1):
        head = b["text"][:88].replace("\n", " ")
        lines.append("")
        lines.append("  %2d. score %-4d  %d bytes  ~%d tokens  x%d prompts"
                     % (rank, b["score"], b["bytes"], b["est_tokens"],
                        b["occurrences"]))
        lines.append("      %s..." % head)
        lines.append("      signals: %s" % (", ".join(b["signals"]) or "none"))
    lines.append("")
    lines.append("  " + ADVISORY)
    return "\n".join(lines)


def main(argv=None):
    parser = _Parser(
        description="Rank system-prompt blocks by deletion-candidate value. "
                    "Advisory: ranks candidates, does not decide.")
    parser.add_argument("fixture_root", nargs="?", default=None,
                        help="directory of fixture-*/expected.txt "
                             "(default: the repo's build_prompt corpus)")
    parser.add_argument("--json", action="store_true",
                        help="emit machine-readable output")
    parser.add_argument("--top", type=int, default=10,
                        help="how many ranked blocks to print (default 10)")
    args = parser.parse_args(argv)

    if args.fixture_root is not None and not os.path.exists(args.fixture_root):
        # 66 input missing. Emitted as JSON under --json: a consumer that asked
        # for machine output must not get a bare line it cannot parse.
        payload = {"status": "input_missing", "exit_code": 66,
                   "error": "no such path: " + args.fixture_root}
        print(json.dumps(payload, indent=2) if args.json
              else "INPUT MISSING -- no such path: " + args.fixture_root)
        return 66

    root = args.fixture_root or os.path.join(_ROOT, FIXTURE_GLOB)

    try:
        report = analyse(root)
    except ScanError as exc:
        payload = {"status": "scan_failed", "exit_code": 2, "error": str(exc)}
        print(json.dumps(payload, indent=2) if args.json
              else "CANNOT SCAN -- " + str(exc))
        return 2

    code = _exit_code(report)
    if args.json:
        print(json.dumps({
            "status": "nothing_to_analyze" if code == 3 else "ranked",
            "exit_code": code,
            "advisory": ADVISORY,
            "measured_deletion_value": "UNKNOWN",
            "report": report,
        }, indent=2))
    else:
        print(_render(report, code, max(args.top, 0)))
    return code


if __name__ == "__main__":
    sys.exit(main())
