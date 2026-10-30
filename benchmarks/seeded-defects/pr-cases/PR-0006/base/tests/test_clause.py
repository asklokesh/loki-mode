# PR-0006: seeded PR fixture check (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src import *  # noqa


def test_clause():
    try:
        read_name('/srv', '../secret')
    except ValueError:
        pass
    else:
        raise AssertionError('traversal accepted')
