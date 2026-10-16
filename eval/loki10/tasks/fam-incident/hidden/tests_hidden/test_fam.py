import os, subprocess, sys

def fail(m):
    print('FAIL: ' + m)
    sys.exit(1)

OLD = "def summarize(cart):\n    total = sum(cart)\n    return {'total': total, 'per_item': total / len(cart)}\n"
r = subprocess.run([sys.executable, '-c', 'import handler; print(handler.summarize([]), handler.summarize([2, 4]))'], capture_output=True, text=True)
if r.stdout.strip() != "{'total': 0, 'per_item': 0.0} {'total': 6, 'per_item': 3.0}": fail('got %r %r' % (r.stdout, r.stderr[-200:]))
if not os.path.isfile('test_handler.py'): fail('no regression test')
new = open('handler.py').read()
open('handler.py', 'w').write(OLD)
try:
    if subprocess.run([sys.executable, 'test_handler.py'], capture_output=True).returncode == 0: fail('regression test passes on the old code')
finally:
    open('handler.py', 'w').write(new)
if subprocess.run([sys.executable, 'test_handler.py'], capture_output=True).returncode != 0: fail('regression test fails on the fix')
print('PASS')
