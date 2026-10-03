#!/usr/bin/env python3
"""Report modules that SHIP to users but nothing at runtime can reach.

This repo has a recurring defect: a subsystem is built, tested, listed in
package.json files[], and never wired to anything that runs. It passes CI (its
own tests import it), it ships to every npm user, and it does nothing. The
CHANGELOG then describes it as a feature.

The distinction that matters is NOT "does anything reference this file" -- tests
and CI smoke-imports reference everything. It is "does any RUNTIME path reach
it". A module referenced only by its own tests and by a workflow that does
`node -e "require(...)"` is proven to LOAD, not to RUN.

Exit 0 = every entry has a runtime reachability verdict recorded in
ALLOWLIST below. Exit 1 = an unlisted unreachable module ships. Exit 2 = the
scan could not run (unmeasured, never reported as clean).

Adding an entry to ALLOWLIST is a deliberate act: it records that someone
looked and decided shipping it is correct, with the reason. It is not a way to
silence the check.
"""
import json
import os
import re
import sys

# Modules that ship unreachable, with the decision and reason. Each entry is a
# claim someone verified, not a mute button.
ALLOWLIST = {
    "src/integrations/sync-subscriber.js":
        "UNREACHABLE, retained. Nothing spawns it (verified: the only matches "
        "for its name are its own log strings). Its Jira branch would also "
        "throw on construction: it passes {baseUrl, token} while "
        "jira/api-client.js:32 requires {baseUrl, email, apiToken} (verified by "
        "execution). The CHANGELOG claim of bidirectional sync was corrected "
        "instead of deleting working adapter code.",

    # The four package entry points are required ONLY by
    # .github/workflows/integrity-audit.yml, which runs
    # node -e "require('./src/integrations/<x>')". That proves the module LOADS.
    # It does not prove anything RUNS it, and nothing does: the only dispatcher
    # is sync-subscriber.js above, which is never spawned.
    "src/integrations/jira/index.js":
        "UNREACHABLE at runtime; loaded only by the CI import smoke test. The "
        "Jira READ path users actually use is autonomy/issue-providers.sh:321 "
        "(shell, unrelated to this module). Retained: deleting it would break "
        "that CI check and the adapters it re-exports, which are tested.",
    "src/integrations/linear/index.js":
        "UNREACHABLE at runtime; same shape as jira/index.js. Linear has no "
        "shell read path either, so Linear support is not user-reachable at "
        "all today. Recorded rather than advertised.",
    "src/integrations/slack/index.js":
        "UNREACHABLE at runtime; loaded only by the CI import smoke test.",
    "src/integrations/teams/index.js":
        "UNREACHABLE at runtime; loaded only by the CI import smoke test.",

    "src/integrations/github/action-handler.js":
        "Reachable ONLY from .github/workflows/loki-enterprise.yml, which is "
        "this repo's own CI, not the shipped product. It ships to npm users "
        "who have no path to it. Retained because the workflow genuinely uses "
        "it; the honest statement is that it is CI tooling that happens to "
        "ship, not a user feature.",
    "src/integrations/slack/commands.js":
        "UNREACHABLE at runtime; no dispatcher reaches slash-command handling.",
    "src/integrations/teams/webhook.js":
        "UNREACHABLE at runtime; no server route mounts this handler.",
}


# Directories whose contents are never runtime-reachable by design.
# graphify-out and artifacts are GENERATED caches: they index every path in the
# repo, so a name appearing there is not evidence anything calls it. Leaving
# them in made sync-subscriber.js look reachable from a stat-index.json, which
# is exactly the vacuous pass this scanner exists to prevent.
SKIP_DIRS = {".git", "node_modules", "__pycache__", "dist", "coverage",
             ".venv", "venv", "build", ".pytest_cache", "tests", "test",
             ".loki", "docs", "wiki", "references", "templates", "demo",
             "graphify-out", "artifacts", "benchmarks", "internal"}

# A reference from one of these is NOT evidence of runtime reachability.
NON_RUNTIME = re.compile(r"(^|/)(tests?|__tests__|\.github)/")


def shipped_globs():
    """Which paths package.json actually ships."""
    with open("package.json", encoding="utf-8") as fh:
        return [e.rstrip("/") for e in json.load(fh).get("files", [])]


def js_modules_under(prefix):
    out = []
    for dirpath, dirnames, filenames in os.walk(prefix):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(".js"):
                out.append(os.path.join(dirpath, name).lstrip("./"))
    return out


def referenced_from_runtime(module_path, corpus):
    """Is module_path required or spawned from a file that actually runs?

    Matches REQUIRE/IMPORT/SPAWN SYNTAX, not a bare substring. A bare substring
    match reported api-client.js as reachable from a legacy UI component and
    from package-lock.json, neither of which calls it. Proximity is not a
    caller, and a guard built on proximity picks up slack it was never meant to
    have.
    """
    stem = os.path.splitext(os.path.basename(module_path))[0]
    parent = os.path.basename(os.path.dirname(module_path))
    # Candidate specifiers a real caller would write.
    specs = [
        module_path,                       # src/integrations/x/y.js
        module_path[:-3],                  # src/integrations/x/y
        "./" + module_path,
        "%s/%s" % (parent, stem),          # x/y
        "./%s/%s" % (parent, stem),
        "./" + stem,
    ]
    # Factored form of the per-spec alternation (require|from|import) x specs,
    # plus node/bun invoking the file directly (shell launchers). Same match
    # set as the former 24-way flat alternation, much cheaper to search.
    spec_alt = "|".join(re.escape(sp) for sp in specs)
    rx = re.compile(
        r"(?:require\(\s*['\"]|from\s+['\"]|import\(\s*['\"])"
        r"(?:" + spec_alt + r")(\.js)?['\"]"
        r"|(node|bun)\s+[^\n]*" + re.escape(module_path))

    for path, text in corpus:
        if path == module_path:
            continue
        # Every alternative in rx contains `stem` literally, so a file without
        # it cannot match. Measured: regex 47.06s vs file I/O 0.09s of the scan;
        # this prefilter took it to 17.7s, the factored rx above to 3.2s.
        if stem not in text:
            continue
        if NON_RUNTIME.search("/" + path):
            continue
        if rx.search(text):
            return path
    return None


def main():
    try:
        ships = shipped_globs()
        if "src/" not in [s + "/" for s in ships] and "src" not in ships:
            # src/ is not shipped; nothing to report from it.
            return 0

        corpus = []
        for dirpath, dirnames, filenames in os.walk("."):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if not name.endswith((".js", ".ts", ".sh", ".py", ".json")):
                    continue
                p = os.path.join(dirpath, name).lstrip("./")
                try:
                    with open(p, encoding="utf-8") as fh:
                        corpus.append((p, fh.read()))
                except (UnicodeDecodeError, OSError):
                    continue

        offenders = []
        for mod in js_modules_under("src/integrations"):
            if referenced_from_runtime(mod, corpus):
                continue
            if mod in ALLOWLIST:
                continue
            offenders.append(mod)
    except Exception as exc:  # noqa: BLE001 - unmeasured, never clean
        sys.stderr.write("UNMEASURED: %s: %s\n" % (type(exc).__name__, exc))
        return 2

    for o in sorted(offenders):
        print("%s: ships but no runtime path reaches it" % o)
    return 1 if offenders else 0


if __name__ == "__main__":
    sys.exit(main())
