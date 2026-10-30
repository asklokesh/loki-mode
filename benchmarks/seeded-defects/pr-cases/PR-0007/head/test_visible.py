# PR-0007: seeded PR fixture (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from src import *  # noqa
assert clamp(-1, 0, 10) == 0
assert clamp(5, 0, 10) == 5
