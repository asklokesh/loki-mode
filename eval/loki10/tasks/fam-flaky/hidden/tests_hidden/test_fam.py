import os, subprocess, sys

def fail(m):
    print('FAIL: ' + m)
    sys.exit(1)

for seed in range(12):
    env = dict(os.environ, PYTHONHASHSEED=str(seed))
    r = subprocess.run([sys.executable, 'test_rank.py'], capture_output=True, text=True, env=env)
    if r.returncode != 0: fail('seed %d: rc=%d' % (seed, r.returncode))
    r = subprocess.run([sys.executable, '-c', "from rank import first_tag; print(first_tag(['z','m','b','q']))"], capture_output=True, text=True, env=env)
    if r.stdout.strip() != 'b': fail('seed %d: first_tag -> %r' % (seed, r.stdout))
print('PASS')
