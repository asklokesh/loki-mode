# PR-0006: seeded PR fixture (benchmarks/seeded-defects/pr-cases)
import os

def read_name(base, name):
    return os.path.join(base, name.strip())
