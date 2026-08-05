"""Suite-wide safety net: never let an inherited git environment reach a test.

`git` exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and friends into every
hook it runs. Anything launched from a hook -- pytest included -- inherits
them, and they are inherited again by every `git` subprocess a test spawns.

That matters because `subprocess.run([...], cwd=fixture_repo)` does NOT
override GIT_DIR. `cwd` sets the working directory; GIT_DIR overrides which
repository git acts on, and it wins. So a test that builds a throwaway repo
and commits into it will, under a hook, commit into the REAL repository
instead.

This is not hypothetical. Measured 2026-07-31: running the suite from the
pre-push hook produced 22 CalledProcessError failures across test_wiki_index,
test_wiki_generator and others -- and silently wrote fixture commits
("init", "second", adding src/calc.py and node_modules/junk/x.js) onto the
live branch, which then reached origin/main.

Thirteen call sites across five test modules use `cwd=` without `-C`. Rather
than patch each one and rely on the next test author remembering, strip the
variables once here. autouse + session scope means every test in the suite is
covered, including ones not yet written.

The pre-push hook also strips these before invoking pytest. That belt is worth
keeping -- it protects anything the hook runs -- but this is the braces, and it
protects the suite however it is invoked (CI, a local run, another hook, an
editor plugin).
"""

import os

import pytest

# Every variable through which git can redirect a subprocess at a different
# repository, index, object store, or worktree.
_GIT_ENV_LEAKS = (
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_QUARANTINE_PATH",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
)


@pytest.fixture(scope="session", autouse=True)
def _strip_inherited_git_env():
    """Remove git's exported environment for the whole session."""
    saved = {name: os.environ.pop(name) for name in _GIT_ENV_LEAKS
             if name in os.environ}
    try:
        yield
    finally:
        os.environ.update(saved)
