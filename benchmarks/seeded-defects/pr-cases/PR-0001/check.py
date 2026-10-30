# PR-0001: seeded PR fixture (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from src import *  # noqa
assert total(1, 10) == 55, total(1, 10)
