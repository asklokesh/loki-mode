# PR-0001: seeded PR fixture check (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src import *  # noqa


def test_clause():
    assert total(1, 10) == 55, total(1, 10)
