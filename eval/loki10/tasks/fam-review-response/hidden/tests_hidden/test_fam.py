import os, subprocess, sys

def fail(m):
    print('FAIL: ' + m)
    sys.exit(1)

r = subprocess.run([sys.executable, '-c', 'import calc; print(repr(calc.avg([])), repr(calc.avg([2, 2])), repr(calc.avg([1, 2])), bool(calc.avg.__doc__ and calc.avg.__doc__.strip()))'], capture_output=True, text=True)
if r.stdout.strip() != '0.0 2.0 1.5 True': fail('got %r %r' % (r.stdout, r.stderr[-200:]))
if open('REVIEW.md').read().count('\n') != 3: fail('REVIEW.md was edited')
print('PASS')
