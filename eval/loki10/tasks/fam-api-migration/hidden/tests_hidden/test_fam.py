import os, subprocess, sys

def fail(m):
    print('FAIL: ' + m)
    sys.exit(1)

API_SRC = "USERS = {1: 'Ada'}\n\ndef fetch_user(user_id):\n    return {'data': {'name': USERS[user_id]}}\n"
if open('api.py').read() != API_SRC: fail('api.py was edited')
if 'get_user' in open('client.py').read(): fail('client.py still uses get_user')
r = subprocess.run([sys.executable, '-c', 'import client; print(client.display_name(1))'], capture_output=True, text=True)
if r.stdout.strip() != 'Ada': fail('display_name(1) -> %r %r' % (r.stdout, r.stderr[-200:]))
print('PASS')
