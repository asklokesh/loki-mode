# PR-0006: seeded PR fixture (benchmarks/seeded-defects/pr-cases)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from src import *  # noqa
assert read_name('/srv', 'a.txt') == '/srv/a.txt'
