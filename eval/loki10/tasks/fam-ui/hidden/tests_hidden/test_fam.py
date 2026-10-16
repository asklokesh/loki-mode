import os, subprocess, sys

def fail(m):
    print('FAIL: ' + m)
    sys.exit(1)

from html.parser import HTMLParser
class P(HTMLParser):
    def __init__(s):
        super().__init__(); s.ids=set(); s.fors=set(); s.title=False; s.form=False; s.btn=False; s.t=''
    def handle_starttag(s, tag, a):
        a = dict(a)
        if 'id' in a: s.ids.add(a['id'])
        if tag == 'label' and 'for' in a: s.fors.add(a['for'])
        if tag == 'title': s.title = True
        if tag == 'form': s.form = True
        if tag == 'button' and a.get('type') == 'submit' and s.form: s.btn = True
    def handle_data(s, d):
        if s.title: s.t += d
    def handle_endtag(s, tag):
        if tag == 'title': s.title = False
try:
    src = open('index.html', encoding='utf-8').read()
except OSError as e:
    fail('index.html missing: %s' % e)
p = P(); p.feed(src)
if not p.t.strip(): fail('no title text')
for i in ('email', 'pw'):
    if i not in p.ids or i not in p.fors: fail('input %s lacks id or label' % i)
if not p.btn: fail('no submit button inside form')
print('PASS')
