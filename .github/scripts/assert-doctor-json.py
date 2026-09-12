#!/usr/bin/env python3
"""Assert a released artifact's `loki doctor --json` is healthy FOR A CI RUNNER.

THE DEFECT this replaces: the smoke step asserted `loki doctor --json` exits 0.
A GitHub runner has no Claude/Codex/Cline/Aider CLI installed, so doctor
correctly reports `ai_provider: {found: false, status: fail}` and correctly
exits 1 -- Loki genuinely cannot run a build there. The assertion encoded an
assumption about host state that the host never satisfied, so Post-Release
Smoke failed on SEVEN consecutive non-skipped runs and posted to Slack on each
one. A gate that has never passed is not a gate; it is noise that trains
everyone to ignore the one check that looks at what users actually install.

WHY NOT JUST IGNORE THE EXIT CODE: that makes the gate vacuous, and this gate
is load-bearing -- it is the only thing that inspects the PUBLISHED artifact
rather than a git checkout, the blind spot that shipped broken detectors in
v8.38.0 and a wrong hardcoded version for 27 releases.

So: the expected-absent provider is named explicitly, and ANY other failure is
still red. Assert each thing individually, never a count.
"""
import json
import sys

# The ONLY failure a provider-less CI runner may report. Anything else is a
# real defect in the published artifact.
EXPECTED_ABSENT = {"ai_provider"}


def collect_failures(node, path="", out=None):
    """Walk the whole document; doctor nests status under several keys."""
    if out is None:
        out = []
    if isinstance(node, dict):
        if node.get("status") == "fail":
            name = node.get("name") or node.get("check") or node.get("id")
            # A failing entry inside a named list carries its own name; a
            # failing top-level SECTION is identified by its key instead.
            out.append(str(name) if name else path.lstrip("."))
        for k, v in node.items():
            collect_failures(v, "%s.%s" % (path, k), out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            collect_failures(v, "%s[%d]" % (path, i), out)
    return out


def main():
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else path

    with open(path) as fh:
        doc = json.load(fh)          # invalid JSON raises -> non-zero exit

    # VACUITY GUARD. An empty or truncated document has no failures either, and
    # would sail through every assertion below while measuring nothing.
    if not isinstance(doc, dict) or "summary" not in doc or "checks" not in doc:
        print("FATAL(%s): doctor JSON is missing summary/checks; "
              "nothing was actually verified" % label)
        print(json.dumps(doc)[:400])
        return 1
    if not doc.get("checks"):
        print("FATAL(%s): doctor reported ZERO checks; the artifact may be "
              "broken in a way that produces no output" % label)
        return 1

    version = doc.get("loki_mode_version")
    if not version:
        print("FATAL(%s): doctor JSON carries no loki_mode_version" % label)
        return 1

    failures = set(collect_failures(doc))
    unexpected = failures - EXPECTED_ABSENT

    print("%s: version=%s checks=%d summary=%s"
          % (label, version, len(doc["checks"]), doc.get("summary")))
    print("%s: failing=%s (expected-absent on a CI runner: %s)"
          % (label, sorted(failures) or "none", sorted(EXPECTED_ABSENT)))

    if unexpected:
        print("FATAL(%s): unexpected failing checks in the PUBLISHED artifact: %s"
              % (label, sorted(unexpected)))
        return 1

    print("%s: doctor is healthy for a provider-less runner" % label)
    return 0


if __name__ == "__main__":
    sys.exit(main())
