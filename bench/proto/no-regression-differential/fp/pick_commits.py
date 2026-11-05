"""Pre-registered selection of real fix commits for the false-positive replay. Run: python3 -I pick_commits.py <repo-dir> <n>"""
import re, subprocess, sys
repo, n = sys.argv[1], int(sys.argv[2])
git = lambda *a: subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True, timeout=120).stdout
FIXY = re.compile(r"fix|bug|correct|handle|wrong|incorrect|should|panic|error|issue|#\d+", re.I)
SKIP = re.compile(r"typo|\bdoc|comment|lint|refactor|\btest|bump|\bci\b|readme|vendor|go\.mod|deprecat|license|example", re.I)
picked = 0
for sha in git("rev-list", "--first-parent", "--no-merges", "HEAD").split():
    subj = git("log", "-1", "--format=%s", sha).strip()
    if not FIXY.search(subj) or SKIP.search(subj):
        continue
    stat = [l.split("\t") for l in git("diff", "--numstat", f"{sha}^", sha).strip().splitlines() if l]
    code = [s for s in stat if s[2].endswith(".go") and not s[2].endswith("_test.go")]
    if len(code) != 1 or any(not s[2].endswith(".go") and not s[2].endswith(".md") for s in stat if s not in code and not s[2].endswith("_test.go")):
        continue
    add, rem, path = code[0]
    if add == "-" or not (3 <= int(add) + int(rem) <= 60) or "/vendor/" in path or path.startswith("vendor/"):
        continue
    pkgdir = path.rsplit("/", 1)[0] if "/" in path else "."
    tests = [f for f in git("ls-tree", "--name-only", f"{sha}^", *([f"{pkgdir}/"] if pkgdir != "." else [])).split() if f.endswith("_test.go")]
    if not tests:
        continue
    print(f"{sha[:10]}\t{path}\t+{add}/-{rem}\t{subj[:90]}")
    picked += 1
    if picked >= n:
        break
