# PR-0007: seeded PR fixture check (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src import *  # noqa


def test_clause():
    assert clamp(-1, 0, 10) == 0
    assert scale(3, 4) == 12, scale(3, 4)
