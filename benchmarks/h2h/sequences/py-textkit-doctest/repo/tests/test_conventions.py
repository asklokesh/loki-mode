"""Repo conventions every public function in textkit/transforms.py must follow."""
import doctest
import inspect

import pytest

from textkit import transforms

PUBLIC = [name for name, fn in inspect.getmembers(transforms, inspect.isfunction)
          if not name.startswith("_") and fn.__module__ == transforms.__name__]


@pytest.mark.parametrize("name", PUBLIC)
def test_listed_in_all(name):
    assert name in transforms.__all__, f"add {name!r} to __all__ in textkit/transforms.py (the package re-exports __all__)"


@pytest.mark.parametrize("name", PUBLIC)
def test_has_a_doctest_example(name):
    doc = getattr(transforms, name).__doc__ or ""
    assert ">>> " in doc, f"give {name} a docstring with at least one >>> example; this test runs it"


def test_doctest_examples_pass():
    result = doctest.testmod(transforms, verbose=False)
    assert result.failed == 0, f"{result.failed} doctest example(s) in textkit/transforms.py fail"
