import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, _, b = req("GET", "/health")
    expect(s == 200 and jbody(b).get("status") == "ok", "GET /health -> %s" % s)
    s, _, b = req("GET", "/convert?from=USD&to=EUR&amount=10")
    expect(s == 200, "convert USD->EUR -> %s" % s)
    r = jbody(b)
    expect(abs(float(r.get("result", -1)) - 9.2) < 1e-6, "10 USD->EUR should be 9.2: %r" % r)
    s, _, b = req("GET", "/convert?from=EUR&to=GBP&amount=46")
    expect(s == 200 and abs(float(jbody(b).get("result", -1)) - 39.0) < 0.01, "46 EUR->GBP should be 39.0: %r" % b[:100])
    s, _, _ = req("GET", "/convert?from=USD&to=XYZ&amount=1")
    expect(s == 400, "unknown currency should be 400, got %s" % s)
    s, _, _ = req("GET", "/convert?from=USD&to=EUR&amount=abc")
    expect(s == 400, "non-numeric amount should be 400, got %s" % s)
    s, _, b = req("GET", "/metrics")
    text = b.decode(errors="replace")
    expect(s == 200, "GET /metrics -> %s" % s)
    line = [ln for ln in text.splitlines() if ln.startswith("convert_requests_total ")]
    expect(line and line[0].split()[1] == "4", "metrics should report convert_requests_total 4, got %r" % line)


run(check)
