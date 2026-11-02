"""Repo conventions every converter in units/converters.py must follow."""
import inspect

import pytest

from units import converters, registry

PUBLIC = [name for name, fn in inspect.getmembers(converters, inspect.isfunction)
          if not name.startswith("_") and fn.__module__ == converters.__name__]


@pytest.mark.parametrize("name", PUBLIC)
def test_every_converter_is_registered(name):
    entry = registry.CONVERTERS.get(name)
    assert entry is not None, f"register {name} in units/registry.py CONVERTERS as (function, from_unit, to_unit)"
    assert entry[0] is getattr(converters, name), f"CONVERTERS[{name!r}] must point at converters.{name}"
    assert all(isinstance(u, str) and u for u in entry[1:]), f"CONVERTERS[{name!r}] needs non-empty unit strings"


@pytest.mark.parametrize("name", PUBLIC)
def test_every_converter_rejects_non_numbers(name):
    fn = getattr(converters, name)
    for bad in ("1", None, True):
        with pytest.raises(TypeError):
            fn(bad)
