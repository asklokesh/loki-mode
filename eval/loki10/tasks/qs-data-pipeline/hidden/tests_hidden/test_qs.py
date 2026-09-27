import json
import os
import subprocess
import sys
import tempfile


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


CSV = """date,region,amount
2026-01-01,north,10.50
2026-01-02,south,5
2026-01-02,North,4.50
bad-row-without-enough-fields
2026-01-03,east,not-a-number
2026-01-04,south,2.25
"""

with tempfile.TemporaryDirectory() as d:
    src, dst = os.path.join(d, "in.csv"), os.path.join(d, "out.json")
    with open(src, "w") as fh:
        fh.write(CSV)
    try:
        r = subprocess.run(["sh", "pipeline.sh", src, dst], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail("pipeline.sh did not run: %s" % e)
    if r.returncode != 0:
        fail("pipeline.sh exit %s stderr %r" % (r.returncode, r.stderr[:300]))
    try:
        with open(dst) as fh:
            out = json.load(fh)
    except (OSError, ValueError) as e:
        fail("output JSON unreadable: %s" % e)
    want = {
        "regions": [
            {"region": "north", "total": 15.0, "count": 2},
            {"region": "south", "total": 7.25, "count": 2},
        ],
        "rows_ok": 4,
        "rows_skipped": 2,
    }
    if out != want:
        fail("got %r want %r" % (out, want))
    r = subprocess.run(["sh", "pipeline.sh", os.path.join(d, "nope.csv"), dst], capture_output=True, text=True, timeout=60)
    if r.returncode == 0:
        fail("missing input file should exit non-zero")
print("PASS")
# Last stdout line, only reached when every check passed.
print(os.environ.get("LOKI_EVAL_NONCE", ""))
