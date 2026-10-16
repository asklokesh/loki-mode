import os, subprocess, sys

def fail(m):
    print('FAIL: ' + m)
    sys.exit(1)

def load(env):
    e = {k: v for k, v in os.environ.items() if k not in ('APP_ENV', 'STAGING_DB_URL')}
    e.update(env)
    r = subprocess.run([sys.executable, '-c', 'import config; print(config.load())'], capture_output=True, text=True, env=e)
    return r.stdout.strip() + r.stderr[-200:]
if load({}) != "{'db': 'sqlite:///dev.db', 'debug': True}": fail('default changed: ' + load({}))
stg = {'APP_ENV': 'staging', 'STAGING_DB_URL': 'postgres://stg/x'}
if load(stg) != "{'db': 'postgres://stg/x', 'debug': False}": fail('staging: ' + load(stg))
print('PASS')
