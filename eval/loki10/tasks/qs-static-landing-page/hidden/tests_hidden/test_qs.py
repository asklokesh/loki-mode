import html.parser
import sys


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


class P(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.title, self.h1 = [], "", ""
        self.plans, self.email_inputs, self.viewport, self.ids, self.imgs_no_alt = 0, 0, False, set(), 0
        self.in_pricing = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.stack.append(tag)
        if a.get("id"):
            self.ids.add(a["id"])
        if a.get("id") == "pricing":
            self.in_pricing = len(self.stack)
        if self.in_pricing and "plan" in (a.get("class") or "").split():
            self.plans += 1
        if tag == "input" and a.get("type") == "email":
            self.email_inputs += 1
        if tag == "meta" and a.get("name") == "viewport":
            self.viewport = True
        if tag == "img" and not a.get("alt"):
            self.imgs_no_alt += 1

    def handle_endtag(self, tag):
        while self.stack:
            t = self.stack.pop()
            if self.in_pricing and len(self.stack) < self.in_pricing:
                self.in_pricing = 0
            if t == tag:
                break

    def handle_data(self, data):
        if "title" in self.stack:
            self.title += data
        if "h1" in self.stack:
            self.h1 += data


try:
    src = open("index.html", encoding="utf-8").read()
except OSError:
    fail("index.html not found at repo root")
p = P()
p.feed(src)
if "Brightline" not in p.title:
    fail("<title> must contain Brightline, got %r" % p.title)
if "Brightline" not in p.h1:
    fail("<h1> must contain Brightline, got %r" % p.h1)
if not p.viewport:
    fail("missing <meta name=viewport>")
if p.plans != 3:
    fail("#pricing must contain exactly 3 elements with class plan, found %d" % p.plans)
if p.email_inputs < 1:
    fail("missing <input type=email> signup field")
for sid in ("features", "pricing", "signup"):
    if sid not in p.ids:
        fail("missing section id=%s" % sid)
if p.imgs_no_alt:
    fail("%d <img> without alt text" % p.imgs_no_alt)
print("PASS")
