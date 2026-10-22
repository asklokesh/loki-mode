"""Sweep the owner-only temp a killed secret writer leaves behind (FC-STALE-SECRET-TMP-NEVER-SWEPT).

Mirror of sweepStaleSecretTmp in loki-ts/src/util/atomic.ts. The one Python copy: the bash MCP bundle
writer (autonomy/lib/mcp-config.sh), receipt_jwt.py and dashboard/api_start.py all load this module.
A name is swept when it matches a caller pattern, is a non-directory owned by the current user, and is
not in use: a pid-bearing name (capture group 1) is live while that pid exists, any other name must be
older than SECRET_TMP_GRACE_SECONDS (a live writer holds its temp for milliseconds).
"""
import os
import re
import stat
import time

SECRET_TMP_GRACE_SECONDS = 60


def sweep_stale_secret_tmp(directory, patterns):
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        m = None
        for pat in patterns:
            m = re.match(pat, name)
            if m:
                break
        if not m:
            continue
        path = os.path.join(directory, name)
        try:
            st = os.lstat(path)
            if stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
                continue
            if m.groups():
                pid = int(m.group(1))
                live = pid == os.getpid()
                if not live:
                    try:
                        os.kill(pid, 0)
                        live = True
                    except PermissionError:
                        live = True
                    except OSError:
                        live = False
                if live:
                    continue
            elif time.time() - st.st_mtime < SECRET_TMP_GRACE_SECONDS:
                continue
            os.unlink(path)
        except OSError:
            pass
