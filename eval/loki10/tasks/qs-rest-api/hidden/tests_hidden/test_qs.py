import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, _, b = req("GET", "/health")
    expect(s == 200 and jbody(b) == {"status": "ok"}, "GET /health -> %s %r" % (s, b[:100]))
    s, _, b = req("POST", "/notes", {"title": "t1", "body": "hello"})
    expect(s == 201, "POST /notes status %s" % s)
    note = jbody(b)
    expect(isinstance(note, dict) and "id" in note, "POST /notes missing id: %r" % note)
    expect(note.get("title") == "t1" and note.get("body") == "hello", "POST /notes echo wrong: %r" % note)
    nid = note["id"]
    s, _, b = req("GET", "/notes/%s" % nid)
    expect(s == 200 and jbody(b).get("title") == "t1", "GET /notes/id -> %s" % s)
    s, _, b = req("GET", "/notes")
    lst = jbody(b)
    expect(s == 200 and isinstance(lst, list) and len(lst) == 1, "GET /notes list wrong: %r" % lst)
    s, _, b = req("PUT", "/notes/%s" % nid, {"title": "t2", "body": "bye"})
    expect(s == 200 and jbody(b).get("title") == "t2", "PUT /notes/id -> %s" % s)
    s, _, _ = req("POST", "/notes", {"body": "no title"})
    expect(s == 400, "POST /notes without title should be 400, got %s" % s)
    s, _, _ = req("DELETE", "/notes/%s" % nid)
    expect(s == 204, "DELETE /notes/id should be 204, got %s" % s)
    s, _, _ = req("GET", "/notes/%s" % nid)
    expect(s == 404, "GET deleted note should be 404, got %s" % s)


run(check)
