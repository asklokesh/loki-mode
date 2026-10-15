import argparse
import re
import sys
from collections import Counter


def count_words(text):
    return Counter(re.findall(r"[a-z0-9']+", text.lower()))


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("file")
    args = p.parse_args(argv)
    with open(args.file, encoding="utf-8") as fh:
        counts = count_words(fh.read())
    rows = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    for word, n in rows:
        print("%d %s" % (n, word))
    return 0


if __name__ == "__main__":
    sys.exit(main())
