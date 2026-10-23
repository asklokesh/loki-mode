#!/usr/bin/env python3
"""Uniform acceptance entry point: runs the go hidden tests and returns their exit code."""
import subprocess
import sys

sys.exit(subprocess.call(["go", "test", "-run", "TestHidden", "-count=1", "./..."]))
