#!/usr/bin/env bash
# FC-51: a tarball publish records no gitHead, and promote.yml refuses a
# version with none. Static check of the two workflow definitions, with
# negative cases: each required piece, removed, must make the checker fail.
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


def check(rel, pro):
    """Return a list of failures; empty means the definitions are sound."""
    bad = []
    try:
        steps = yaml.safe_load(rel)['jobs']['publish-npm'].get('steps') or []
    except Exception as e:
        return ['release.yml publish-npm unparsable: %s' % e]
    pack = [s.get('run') or '' for s in steps if 'npm pack' in (s.get('run') or '')]
    if len(pack) != 1:
        return ['expected exactly one npm pack step in publish-npm, got %d' % len(pack)]
    b = pack[0]
    i_set = b.find('npm pkg set gitHead=')
    if i_set < 0 or i_set > b.find('$(npm pack'):
        bad.append('release: no gitHead stamp before npm pack')
    if 'git rev-parse HEAD' not in b:
        bad.append('release: stamp does not come from git rev-parse HEAD')
    if 'tar -xzOf' not in b or '!= HEAD' not in b:
        bad.append('release: packed manifest gitHead is not asserted equal to HEAD')
    if b.count('package.json.orig') < 2:
        bad.append('release: package.json is not restored after pack')
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
    need = {
        'promote: no tag fallback': 'v${VERSION}^{commit}',
        'promote: fallback does not require an annotated tag': 'cat-file -t',
        'promote: fallback does not require a green Tests run on main': 'workflows/test.yml/runs',
        'promote: fallback does not verify the published tarball': 'npm pack "loki-mode@${VERSION}"',
        'promote: fallback does not check the dist embeds VERSION': 'does not embed',
        'promote: source of gitHead is not logged': 'GITHEAD_SOURCE=',
        'promote: 40-hex check lost': '^[0-9a-f]{40}$',
        'promote: ancestor check lost': 'merge-base --is-ancestor "$GITHEAD" origin/main',
        'promote: never-backwards check lost': 'is lower than current latest',
    }
    for msg, frag in need.items():
        if frag not in p:
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
    assert old in text, 'mutation anchor missing: ' + old
    text = text.replace(old, new)
    res = check(text, PRO) if which == 'rel' else check(REL, text)
    expect('negative: ' + name + ' is rejected', bool(res))


mutate('no gitHead stamp', 'rel', 'npm pkg set gitHead="$GITHEAD_STAMP"', 'true')
mutate('no packed-manifest assertion', 'rel', '!= HEAD', '!= X')
mutate('no tag fallback', 'pro', 'v${VERSION}^{commit}', 'v${VERSION}')
mutate('fallback accepts a lightweight tag', 'pro', 'cat-file -t', 'cat-file -p')
mutate('fallback ignores Tests status', 'pro', 'workflows/test.yml/runs', 'workflows/x.yml/runs')
mutate('fallback is trust-on-name', 'pro', 'npm pack "loki-mode@${VERSION}"', 'true')
mutate('ancestry check dropped', 'pro', 'merge-base --is-ancestor "$GITHEAD" origin/main', 'true')
mutate('actions: read dropped', 'pro', '  actions: read\n', '')
print('RESULT: all passed' if not fails else 'RESULT: %d failed' % fails)
sys.exit(1 if fails else 0)
PY
