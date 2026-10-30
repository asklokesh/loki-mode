# PR-0003: seeded PR fixture check (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src import *  # noqa


def test_clause():
    assert normalize_email('  A@B.C ') == 'a@b.c', normalize_email('  A@B.C ')
