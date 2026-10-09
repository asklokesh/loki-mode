#!/usr/bin/env bash
# FC-51: a tarball publish records no gitHead, and promote.yml refuses a
# version with none. Static check of the two workflow definitions. Every
# enforcing line is matched IN FULL (not as a fragment), and each one has a
# negative mutation that must turn the checker red.
# It cannot prove the registry keeps the stamped field; the runtime proof is
# `npm view loki-mode@<next version> gitHead` after the next release.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 not installed (not a pass)"; exit 0; }
python3 -I -c 'import yaml' 2>/dev/null || { echo "  SKIPPED: pyyaml not installed (not a pass)"; exit 0; }
_LOKI_ROOT="$REPO_ROOT" exec python3 -I - <<'PY'
import os, sys, yaml

root = os.environ['_LOKI_ROOT']
REL = open(os.path.join(root, '.github/workflows/release.yml')).read()
PRO = open(os.path.join(root, '.github/workflows/promote.yml')).read()

Q = "'"


def lines(body):
    return [l.strip() for l in body.splitlines()]


def has_seq(body, seq):
    ls = lines(body)
    n = len(seq)
    return any(ls[i:i + n] == seq for i in range(len(ls) - n + 1))


REL_LINES = {
    'release: stamp is not git rev-parse HEAD (fail closed)':
        'GITHEAD_STAMP="$(git rev-parse HEAD)" || { echo "FATAL: git rev-parse HEAD failed"; exit 1; }',
    'release: stamp 40-hex check lost':
        "printf '%s' \"$GITHEAD_STAMP\" | grep -Eq '^[0-9a-f]{40}$' || { echo \"FATAL: HEAD is not a 40-hex SHA: $GITHEAD_STAMP\"; exit 1; }",
    'release: no gitHead stamp': 'npm pkg set gitHead="$GITHEAD_STAMP"',
    'release: package.json not restored after pack': 'cp "$RUNNER_TEMP/package.json.orig" package.json',
    'release: packed manifest is not extracted':
        'tar -xzOf "$tgz" package/package.json > "$RUNNER_TEMP/packed-package.json"',
    'release: packed manifest gitHead not asserted equal to the stamp':
        '[ "$PACKED_HEAD" = "$GITHEAD_STAMP" ] || {',
}

PRO_LINES = {
    'promote: npm gitHead lookup changed':
        'GITHEAD="$(npm view "loki-mode@${VERSION}" gitHead 2>/dev/null || true)"',
    'promote: annotated-tag gate lost':
        'test "$(git cat-file -t "refs/tags/v${VERSION}" 2>/dev/null || true)" = "tag" || {',
    'promote: tag does not resolve to a commit':
        'GITHEAD="$(git rev-parse "v${VERSION}^{commit}")" || { echo "FATAL: cannot resolve tag v${VERSION}"; exit 1; }',
    'promote: Tests query not exact (head_sha, branch=main, status=success)':
        'TESTS_OK="$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/test.yml/runs?head_sha=${GITHEAD}&branch=main&status=success&per_page=1" --jq ' + Q + '.total_count' + Q + ' 2>/dev/null || echo 0)"',
    'promote: Tests gate lost':
        '[ "${TESTS_OK:-0}" -ge 1 ] || { echo "FATAL: no successful Tests run on main for ${GITHEAD}; refusing the tag fallback"; exit 1; }',
    'promote: Release query not exact (head_sha, branch=main, status=success)':
        'REL_OK="$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/release.yml/runs?head_sha=${GITHEAD}&branch=main&status=success&per_page=1" --jq ' + Q + '.total_count' + Q + ' 2>/dev/null || echo 0)"',
    'promote: Release-run gate lost':
        '[ "${REL_OK:-0}" -ge 1 ] || { echo "FATAL: no successful Release run on main for ${GITHEAD}; refusing the tag fallback"; exit 1; }',
    'promote: VERSION-at-commit read lost':
        'COMMIT_VERSION="$(git show "${GITHEAD}:VERSION" 2>/dev/null | tr -d ' + Q + '\\n' + Q + ' || true)"',
    'promote: VERSION-at-commit gate lost':
        '[ "$COMMIT_VERSION" = "$VERSION" ] || { echo "FATAL: VERSION at ${GITHEAD} is ' + Q + '${COMMIT_VERSION}' + Q + ', not ${VERSION}; refusing the tag fallback"; exit 1; }',
    'promote: tarball fetch not fail closed':
        '(cd "$FBDIR" && npm pack "loki-mode@${VERSION}" --silent >/dev/null && tar -xzf ./*.tgz package/loki-ts/dist/loki.js) || { echo "FATAL: cannot fetch the published tarball"; exit 1; }',
    'promote: dist-embeds gate lost':
        'grep -q "\\"${VERSION}\\"" "$FBDIR/package/loki-ts/dist/loki.js" || {',
    'promote: source of gitHead is not logged (npm)':
        'echo "GITHEAD_SOURCE=npm (registry gitHead ${GITHEAD})"',
    'promote: source of gitHead is not logged (tag)':
        'echo "GITHEAD_SOURCE=tag v${VERSION} (commit ${GITHEAD}); npm had none"',
    'promote: 40-hex check lost':
        "printf '%s' \"$GITHEAD\" | grep -Eq '^[0-9a-f]{40}$' || { echo \"gitHead is not a 40-hex SHA: $GITHEAD\"; exit 1; }",
    'promote: ancestor check lost':
        'if ! git merge-base --is-ancestor "$GITHEAD" origin/main; then',
}

PRO_SEQS = {
    'promote: never-backwards check does not exit': [
        'echo "FATAL: ${VERSION} is lower than current latest ${CUR}; not promoting"', 'exit 1'],
    'promote: ancestor failure does not exit': [
        'echo "FATAL: gitHead ${GITHEAD} of loki-mode@${VERSION} is not an ancestor of origin/main"', 'exit 1'],
}


def check(rel, pro):
    """Return a list of failures; empty means the definitions are sound."""
    bad = []
    try:
        steps = yaml.safe_load(rel)['jobs']['pack-npm'].get('steps') or []
    except Exception as e:
        return ['release.yml pack-npm unparsable: %s' % e]
    pack = [s.get('run') or '' for s in steps if '$(npm pack' in (s.get('run') or '')]
    if len(pack) != 1:
        return ['expected exactly one npm pack step in pack-npm, got %d' % len(pack)]
    ls = lines(pack[0])
    for msg, l in REL_LINES.items():
        if l not in ls:
            bad.append(msg)
    stamp = 'npm pkg set gitHead="$GITHEAD_STAMP"'
    if stamp in ls and ls.index(stamp) > next(i for i, l in enumerate(ls) if '$(npm pack' in l):
        bad.append('release: stamp comes after npm pack')
    try:
        wf = yaml.safe_load(pro)
        cand = [s for s in wf['jobs']['promote']['steps']
                if 'gitHead' in (s.get('run') or '') and 'is-ancestor' in (s.get('run') or '')]
        perms = wf.get('permissions') or {}
    except Exception as e:
        return bad + ['promote.yml unparsable: %s' % e]
    if len(cand) != 1:
        return bad + ['promote: gitHead step not found']
    p = cand[0]['run']
    pls = lines(p)
    for msg, l in PRO_LINES.items():
        if l not in pls:
            bad.append(msg)
    for msg, seq in PRO_SEQS.items():
        if not has_seq(p, seq):
            bad.append(msg)
    if perms.get('actions') != 'read':
        bad.append('promote: actions: read permission missing')
    return bad


fails = 0


def expect(name, cond):
    global fails
    print(('  PASS: ' if cond else '  FAIL: ') + name)
    if not cond:
        fails += 1


print('TEST: FC-51 gitHead stamp and promote tag fallback')
real = check(REL, PRO)
expect('real workflows satisfy every requirement' + (' -> ' + '; '.join(real) if real else ''), not real)


def mutate(name, which, old, new):
    text = REL if which == 'rel' else PRO
    assert text.count(old) == 1, 'mutation anchor not unique/present: ' + old
    text = text.replace(old, new)
    res = check(text, PRO) if which == 'rel' else check(REL, text)
    expect('negative: ' + name + ' turns the guard red', bool(res))


QT = 'workflows/test.yml/runs?head_sha=${GITHEAD}&branch=main&status=success'
RT = 'workflows/release.yml/runs?head_sha=${GITHEAD}&branch=main&status=success'
mutate('M1 Tests query drops status=success', 'pro', QT, 'workflows/test.yml/runs?head_sha=${GITHEAD}&branch=main')
mutate('M2 Tests query drops branch=main', 'pro', QT, 'workflows/test.yml/runs?head_sha=${GITHEAD}&status=success')
mutate('M3 Tests gate replaced by true', 'pro', '[ "${TESTS_OK:-0}" -ge 1 ] || {', 'true || {')
mutate('M4 annotated-tag gate neutralised', 'pro', '= "tag" || {', '!= "x" || {')
mutate('M5 dist-embeds gate short-circuited', 'pro', '"$FBDIR/package/loki-ts/dist/loki.js" || {', 'true || {')
mutate('M6 40-hex check dropped', 'pro', "'^[0-9a-f]{40}$' || { echo \"gitHead is not", "'^[0-9a-f]{40}$' || true; { echo \"gitHead is not")
mutate('M7 packed-manifest assert neutralised', 'rel', '[ "$PACKED_HEAD" = "$GITHEAD_STAMP" ] || {', 'true || {')
mutate('M8 package.json restore dropped', 'rel', 'cp "$RUNNER_TEMP/package.json.orig" package.json', 'true')
mutate('M9 never-backwards no longer exits', 'pro',
       'lower than current latest ${CUR}; not promoting"\n            exit 1',
       'lower than current latest ${CUR}; not promoting"\n            true')
mutate('M10 Release-run gate neutralised', 'pro', '[ "${REL_OK:-0}" -ge 1 ] || {', 'true || {')
mutate('M11 Release query drops branch=main', 'pro', RT, 'workflows/release.yml/runs?head_sha=${GITHEAD}&status=success')
mutate('M12 VERSION-at-commit gate neutralised', 'pro', '[ "$COMMIT_VERSION" = "$VERSION" ] || {', 'true || {')
mutate('M13 gitHead stamp removed', 'rel', 'npm pkg set gitHead="$GITHEAD_STAMP"', 'true')
mutate('M14 ancestor check neutralised', 'pro', 'merge-base --is-ancestor "$GITHEAD" origin/main', 'merge-base --is-ancestor "$GITHEAD" "$GITHEAD"')
mutate('M15 actions: read dropped', 'pro', '  actions: read\n', '')
print('RESULT: all passed' if not fails else 'RESULT: %d failed' % fails)
sys.exit(1 if fails else 0)
PY
