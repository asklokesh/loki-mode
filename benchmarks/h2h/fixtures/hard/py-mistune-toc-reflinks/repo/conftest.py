# Added by the benchmark harness, not part of the upstream project: makes src/ importable
# without installing the package.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
