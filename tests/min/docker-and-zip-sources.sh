#!/usr/bin/env bash
# Every source a distribution copies must exist in the repository: each non-stage
# COPY in docker/Dockerfile and docker/Dockerfile.sandbox, and each path the
# release.yml "Create release artifacts" step copies into the Claude Code zip
# (the for-loop directories and the individual runtime files). A missing source
# fails the Docker build or aborts the release step (set -e) after the version is
# already burned; this catches it before the push. Also checks that .dockerignore
# does not exclude a top-level directory a COPY needs.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. docker/Dockerfile: add `COPY --chown=loki:loki plantdir/ ./plantdir/`
#      (a directory that does not exist).
#   2. .github/workflows/release.yml: put `plantdir` in the `for d in ...` loop.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need python3
cd "$ROOT" || exit 2

echo "TEST: Docker COPY and release zip sources exist"

out="$(python3 -I - "$ROOT" <<'PY'
import fnmatch, os, re, shlex, subprocess, sys
root = sys.argv[1]
os.chdir(root)
tracked = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.split("\n")
tracked = [t for t in tracked if t]

def exists(src):
    src = src.rstrip("/")
    if any(c in src for c in "*?["):
        return any(fnmatch.fnmatch(t, src) for t in tracked)
    return any(t == src or t.startswith(src + "/") for t in tracked)

def res(label, bad_list):
    print(("OK " if not bad_list else "NO ") + label + ((" :: " + " ".join(bad_list)) if bad_list else ""))

# --- Dockerfiles: COPY instructions without --from= -------------------------
ignore = [l.strip() for l in open(".dockerignore") if l.strip() and not l.startswith("#")]
ignored_top = {l.rstrip("/") for l in ignore if not l.startswith("!") and not any(c in l for c in "*?[/") or (l.endswith("/") and l.count("/") == 1)}
reincluded = {l[1:].split("/")[0].rstrip("/") for l in ignore if l.startswith("!")}
for df in ("docker/Dockerfile", "docker/Dockerfile.sandbox"):
    text = open(df).read().replace("\\\n", " ")
    missing, ignored = [], []
    n = 0
    for line in text.split("\n"):
        if not re.match(r"\s*COPY\s", line):
            continue
        toks = shlex.split(line)[1:]
        flags = [t for t in toks if t.startswith("--")]
        args = [t for t in toks if not t.startswith("--")]
        if any(f.startswith("--from") for f in flags):
            continue
        for src in args[:-1]:
            n += 1
            if not exists(src):
                missing.append(src)
            top = src.split("/")[0]
            if top in ignored_top and top not in reincluded and not src.startswith("tests/docker"):
                ignored.append(src)
    res("%s: %d COPY sources exist in git" % (df, n), missing)
    res("%s: .dockerignore keeps every COPY source" % df, ignored)
    if n < 10:
        res("%s: parsed too few COPY lines (%d)" % (df, n), ["parse"])

# --- release.yml: Claude Code zip copy ---------------------------------------
yml = open(".github/workflows/release.yml").read()
a = yml.index("name: Create release artifacts")
b = yml.index("name: Create Git Tag", a)
step = yml[a:b].replace("\\\n", " ")
srcs = []
for m in re.finditer(r"for\s+\w+\s+in\s+([^;]+?);\s*do", step):
    srcs += m.group(1).split()
for line in step.split("\n"):
    m = re.match(r"\s*cp\s+(.*)$", line)
    if not m:
        continue
    toks = [t for t in shlex.split(m.group(1), comments=True) if not t.startswith("-") and t != "||" and t != "true"]
    toks = [t for t in toks if not t.startswith(("release/", "$", ">", "2>"))]
    srcs += toks[:-1] if len(toks) > 1 else []
srcs = [s for s in srcs if not s.startswith(("release", "$"))]
missing = [s for s in dict.fromkeys(srcs) if not exists(s) and s != "LICENSE"]
res("release.yml zip step: %d copied sources exist in git" % len(set(srcs)), missing)
if len(set(srcs)) < 10:
    res("release.yml zip step: parsed too few sources (%d)" % len(set(srcs)), ["parse"])
PY
)"
printf '%s\n' "$out" > "$T/res.txt"
while IFS= read -r l; do
    case "$l" in
        "OK "*) ok "${l#OK }" ;;
        "NO "*) bad "${l#NO }" ;;
        *) [ -n "$l" ] && bad "unexpected output: $l" ;;
    esac
done < "$T/res.txt"

finish
