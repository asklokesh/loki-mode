import os, subprocess, sys

def fail(m):
    print('FAIL: ' + m)
    sys.exit(1)

r = subprocess.run([sys.executable, 'main.py'], capture_output=True, text=True)
if r.returncode != 0 or r.stdout.strip() != "('a', '1')": fail('main.py rc=%d out=%r err=%r' % (r.returncode, r.stdout, r.stderr[-200:]))
print(os.environ.get('LOKI_EVAL_NONCE', 'PASS'))
