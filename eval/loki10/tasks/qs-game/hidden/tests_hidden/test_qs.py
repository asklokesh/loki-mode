import subprocess
import os
import sys


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


def game(*args):
    try:
        return subprocess.run(["sh", "game.sh", *args], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail("game.sh did not run: %s" % e)


CASES = [
    ("winner", "XXXOO....", "X"),
    ("winner", "XO.XO.X..", "X"),
    ("winner", "XXOXO.O..", "O"),
    ("winner", "XOXXOOOXX", "draw"),
    ("winner", "X...O....", "none"),
    ("next", "X...O....", "X"),
    ("next", "X........", "O"),
    ("move", "XX.OO....", "2"),
    ("move", "XO..X....", "8"),
    ("move", "X........", "4"),
]
for cmd, board, want in CASES:
    r = game(cmd, board)
    if r.returncode != 0 or r.stdout.strip() != want:
        fail("game.sh %s %s -> exit %s out %r, want %r" % (cmd, board, r.returncode, r.stdout.strip(), want))
for bad in ("XXXX.....", "XO", "XOZ......", "OO.......", ""):
    r = game("winner", bad)
    if r.returncode != 1:
        fail("invalid board %r should exit 1, got %s" % (bad, r.returncode))
print("PASS")
# Last stdout line, only reached when every check passed.
print(os.environ.get("LOKI_EVAL_NONCE", ""))
