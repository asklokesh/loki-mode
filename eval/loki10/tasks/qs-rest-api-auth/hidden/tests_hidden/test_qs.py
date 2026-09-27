import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, _, _ = req("POST", "/register", {"username": "ada", "password": "s3cret-pass"})
    expect(s == 201, "POST /register -> %s" % s)
    s, _, _ = req("POST", "/register", {"username": "ada", "password": "other-pass"})
    expect(s == 409, "duplicate register should be 409, got %s" % s)
    s, _, _ = req("POST", "/login", {"username": "ada", "password": "wrong"})
    expect(s == 401, "bad password login should be 401, got %s" % s)
    s, _, b = req("POST", "/login", {"username": "ada", "password": "s3cret-pass"})
    expect(s == 200, "login -> %s" % s)
    tok = jbody(b).get("token")
    expect(isinstance(tok, str) and tok, "login returned no token")
    s, _, _ = req("GET", "/me")
    expect(s == 401, "GET /me without token should be 401, got %s" % s)
    s, _, _ = req("GET", "/me", headers={"Authorization": "Bearer not-a-token"})
    expect(s == 401, "GET /me with bogus token should be 401, got %s" % s)
    s, _, b = req("GET", "/me", headers={"Authorization": "Bearer " + tok})
    expect(s == 200, "GET /me with token -> %s" % s)
    me = jbody(b)
    expect(me.get("username") == "ada", "GET /me wrong user: %r" % me)
    expect("password" not in me and "s3cret-pass" not in b.decode(), "GET /me leaks the password")


run(check)
