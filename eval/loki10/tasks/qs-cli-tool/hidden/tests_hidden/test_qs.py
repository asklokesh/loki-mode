import json
import os
import subprocess
import sys
import tempfile


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


def cli(*args, stdin=None):
    try:
        return subprocess.run(["bin/textstat", *args], input=stdin, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail("could not run bin/textstat: %s" % e)


with tempfile.TemporaryDirectory() as d:
    f = os.path.join(d, "a.txt")
    with open(f, "w") as fh:
        fh.write("the cat saw the dog\nThe end\n")
    r = cli(f)
    if r.returncode != 0:
        fail("exit %s, stderr %r" % (r.returncode, r.stderr[:200]))
    try:
        out = json.loads(r.stdout)
    except ValueError:
        fail("stdout is not JSON: %r" % r.stdout[:200])
    want = {"lines": 2, "words": 7, "chars": 28, "top_word": "the"}
    if out != want:
        fail("got %r want %r" % (out, want))
    r = cli("-", stdin="a b\n")
    if r.returncode != 0 or json.loads(r.stdout or "{}").get("words") != 2:
        fail("reading stdin via '-' failed: %r" % r.stdout[:200])
    r = cli(os.path.join(d, "missing.txt"))
    if r.returncode != 2 or r.stdout.strip() or not r.stderr.strip():
        fail("missing file should exit 2 with stderr only; got %s %r %r" % (r.returncode, r.stdout, r.stderr))
print("PASS")
# Last stdout line, only reached when every check passed.
print(os.environ.get("LOKI_EVAL_NONCE", ""))
