#!/usr/bin/env python3
"""Uniform acceptance entry point: runs the node hidden check and returns its exit code."""
import subprocess
import sys

sys.exit(subprocess.call(["node", "check_acceptance.js"]))
