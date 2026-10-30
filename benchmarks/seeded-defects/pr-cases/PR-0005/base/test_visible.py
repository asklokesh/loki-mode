# PR-0005: seeded PR fixture (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from src import *  # noqa
assert square(1) == 1
