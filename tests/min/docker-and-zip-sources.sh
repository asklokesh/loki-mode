#!/usr/bin/env bash
# Every source a distribution copies must exist in the repository: each non-stage
# COPY in docker/Dockerfile and docker/Dockerfile.sandbox, and each path the
# release.yml "Create release artifacts" step copies into the Claude Code zip
# (the for-loop directories and the individual runtime files). A missing source
# fails the Docker build or aborts the release step (set -e) after the version is
# already burned; this catches it before the push. Also checks that .dockerignore
# does not exclude a top-level directory a COPY needs.
#
# Also: a Docker build stage that copies loki-ts/src must copy every loki-ts file src/ imports from
# outside src/ (v11.118.0's image build broke on ../../data/model-pricing.json).
#
# Also: the control-plane server bundles the way docker/Dockerfile.control-plane builds it: a tree holding only
# packages/control-plane (with its own dependencies), loki-ts/src, loki-ts/data and schemas, and NO loki-ts node_modules.
# Any loki-ts file the server reaches must not need a loki-ts dependency at build time (v11.135.0's image broke on a
# static "@anthropic-ai/sdk" import reached through engine10/stages/implement.ts). Skipped when bun or the install is unavailable.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. docker/Dockerfile: add `COPY --chown=loki:loki plantdir/ ./plantdir/`
#      (a directory that does not exist).
#   2. .github/workflows/release.yml: put `plantdir` in the `for d in ...` loop.
#   3. loki-ts/src/runner/sdk_invoker.ts: restore v11.135.0's file (the static value import of "@anthropic-ai/sdk"):
#      the control-plane bundle leg fails with Could not resolve.

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

# Built before the image build, never committed: the docker-build job in release.yml must build it.
_rel = open(".github/workflows/release.yml").read()
BUILT_BEFORE_IMAGE = {"loki-ts/dist"} if re.search(r"Build loki-ts dist[^\n]*\n\s+working-directory: loki-ts\n\s+run: \|[\s\S]*?bun run build", _rel) else set()

def exists(src):
    src = src.rstrip("/")
    if src in BUILT_BEFORE_IMAGE:
        return True
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

# --- Build stages that copy loki-ts/src must also copy every loki-ts file it imports from outside src/ ---
import os, glob
IMPORT_RE = re.compile(r"""from\s+["'](\.\.[^"']+)["']""")
outside = set()
for f in glob.glob("loki-ts/src/**/*.ts", recursive=True):
    for m in IMPORT_RE.finditer(open(f, encoding="utf-8").read()):
        tgt = os.path.normpath(os.path.join(os.path.dirname(f), m.group(1)))
        if tgt.startswith("loki-ts/") and not tgt.startswith("loki-ts/src/"):
            outside.add(tgt)
for df in ("docker/Dockerfile", "docker/Dockerfile.control-plane"):
    # per build stage: a stage that copies loki-ts/src and builds from it must copy what src/ imports
    for i, stage in enumerate(re.split(r"(?m)^FROM\s", open(df).read())[1:], 1):
        lines = [l for l in stage.split("\n") if re.match(r"\s*COPY\s", l) and "--from" not in l]
        copied = [a.rstrip("/") for l in lines for a in shlex.split(l)[1:-1] if not a.startswith("--")]
        if "loki-ts/src" not in copied:
            continue
        gaps = sorted(t for t in outside if not any(t == c or t.startswith(c + "/") for c in copied))
        res("%s stage %d: loki-ts files imported from outside src/ are copied (%d)" % (df, i, len(outside)), gaps)
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

# --- The control-plane server bundles without loki-ts's node_modules (docker/Dockerfile.control-plane build stage) ---
if command -v bun >/dev/null 2>&1; then
    CP="$T/cp-build"; mkdir -p "$CP/packages" "$CP/loki-ts"
    cp -R "$ROOT/packages/control-plane" "$CP/packages/control-plane"; rm -rf "$CP/packages/control-plane/node_modules" "$CP/packages/control-plane/dist"
    cp -R "$ROOT/loki-ts/src" "$ROOT/loki-ts/data" "$CP/loki-ts/"; cp -R "$ROOT/schemas" "$CP/schemas"
    if (cd "$CP/packages/control-plane" && timeout 300 bun install --frozen-lockfile >"$T/cp-install.log" 2>&1); then
        if (cd "$CP/packages/control-plane" && timeout 300 bun run build:server >"$T/cp-build.log" 2>&1); then
            ok "control-plane server bundles with only its own dependencies, as the Docker build stage does"
        else
            bad "control-plane server does not bundle without loki-ts's node_modules: $(grep -m1 -E 'error' "$T/cp-build.log")"
        fi
    else
        echo "  SKIP: control-plane bundle: bun install failed (offline?)"
    fi
else
    echo "  SKIP: control-plane bundle: bun is not installed"
fi

finish
