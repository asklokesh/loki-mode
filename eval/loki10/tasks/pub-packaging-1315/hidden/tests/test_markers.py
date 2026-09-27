# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the BSD License. See the LICENSE file in the root of this repository
# for complete details.

from __future__ import annotations

import itertools
import os
import pickle
import platform
import sys
from typing import Any, NamedTuple, cast
from unittest import mock

import pytest

from packaging._parser import Node, Op, Value, Variable
from packaging.markers import (
    InvalidMarker,
    Marker,
    UndefinedComparison,
    UndefinedEnvironmentName,
    _format_full_version,
    default_environment,
)

VARIABLES = [
    "extra",
    "implementation_name",
    "implementation_version",
    "os_name",
    "platform_machine",
    "platform_release",
    "platform_system",
    "platform_version",
    "python_full_version",
    "python_version",
    "platform_python_implementation",
    "sys_platform",
]

PEP_345_VARIABLES = [
    "os.name",
    "sys.platform",
    "platform.version",
    "platform.machine",
    "platform.python_implementation",
]

SETUPTOOLS_VARIABLES = ["python_implementation"]

OPERATORS = ["===", "==", ">=", "<=", "!=", "~=", ">", "<", "in", "not in"]

VALUES = [
    "1.0",
    "5.6a0",
    "dog",
    "freebsd",
    "literally any string can go here",
    "things @#4 dsfd (((",
]


class TestNode:
    @pytest.mark.parametrize("value", ["one", "two", None, 3, 5, []])
    def test_accepts_value(self, value: str | None | int | list[str]) -> None:
        assert Node(value).value == value  # type: ignore[arg-type]

    @pytest.mark.parametrize("value", ["one", "two"])
    def test_str(self, value: str) -> None:
        assert str(Node(value)) == str(value)

    @pytest.mark.parametrize("value", ["one", "two"])
    def test_repr(self, value: str) -> None:
        assert repr(Node(value)) == f"<Node({str(value)!r})>"

    def test_base_class(self) -> None:
        with pytest.raises(NotImplementedError):
            Node("cover all the code").serialize()


class TestOperatorEvaluation:
    def test_prefers_pep440(self) -> None:
        assert Marker('"2.7.9" < python_full_version').evaluate(
            dict(python_full_version="2.7.10")
        )
        assert not Marker('"2.7.9" < python_full_version').evaluate(
            dict(python_full_version="2.7.8")
        )

    def test_new_string_rules(self) -> None:
        assert not Marker('"b" < python_full_version').evaluate(
            dict(python_full_version="c")
        )
        assert not Marker('"b" < python_full_version').evaluate(
            dict(python_full_version="a")
        )
        assert not Marker('"b" > "a"').evaluate(dict(a="a"))
        assert not Marker('"b" < "a"').evaluate(dict(a="a"))
        assert not Marker('"b" >= "a"').evaluate(dict(a="a"))
        assert not Marker('"b" <= "a"').evaluate(dict(a="a"))
        assert Marker('"a" <= "a"').evaluate(dict(a="a"))

    def test_fails_when_undefined(self) -> None:
        with pytest.raises(UndefinedComparison):
            Marker("'2.7.0' ~= os_name").evaluate()

    def test_allows_prerelease(self) -> None:
        assert Marker('python_full_version > "3.6.2"').evaluate(
            {"python_full_version": "3.11.0a5"}
        )


class FakeVersionInfo(NamedTuple):
    major: int
    minor: int
    micro: int
    releaselevel: str
    serial: int


class TestDefaultEnvironment:
    def test_matches_expected(self) -> None:
        environment = default_environment()

        iver = (
            f"{sys.implementation.version.major}."
            f"{sys.implementation.version.minor}."
            f"{sys.implementation.version.micro}"
        )
        if sys.implementation.version.releaselevel != "final":
            iver = (
                f"{iver}{sys.implementation.version.releaselevel[0]}"
                f"{sys.implementation.version.serial}"
            )

        assert environment == {
            "implementation_name": sys.implementation.name,
            "implementation_version": iver,
            "os_name": os.name,
            "platform_machine": platform.machine(),
            "platform_release": platform.release(),
            "platform_system": platform.system(),
            "platform_version": platform.version(),
            "python_full_version": platform.python_version(),
            "platform_python_implementation": platform.python_implementation(),
            "python_version": ".".join(platform.python_version_tuple()[:2]),
            "sys_platform": sys.platform,
        }

    def test_multidigit_minor_version(self, monkeypatch: pytest.MonkeyPatch) -> None:
        version_info = (3, 10, 0, "final", 0)
        monkeypatch.setattr(sys, "version_info", version_info, raising=False)

        monkeypatch.setattr(platform, "python_version", lambda: "3.10.0", raising=False)
        monkeypatch.setattr(
            platform, "python_version_tuple", lambda: ("3", "10", "0"), raising=False
        )

        environment = default_environment()
        assert environment["python_version"] == "3.10"

    def tests_when_releaselevel_final(self) -> None:
        v = FakeVersionInfo(3, 4, 2, "final", 0)
        assert _format_full_version(v) == "3.4.2"  # type: ignore[arg-type]

    def tests_when_releaselevel_not_final(self) -> None:
        v = FakeVersionInfo(3, 4, 2, "beta", 4)
        assert _format_full_version(v) == "3.4.2b4"  # type: ignore[arg-type]


class TestMarker:
    @pytest.mark.parametrize(
        "marker_string",
        [
            "{} {} {!r}".format(*i)
            for i in itertools.product(VARIABLES, OPERATORS, VALUES)
        ]
        + [
            "{2!r} {1} {0}".format(*i)
            for i in itertools.product(VARIABLES, OPERATORS, VALUES)
        ],
    )
    def test_parses_valid(self, marker_string: str) -> None:
        Marker(marker_string)

    @pytest.mark.parametrize(
        "marker_string",
        [
            "this_isnt_a_real_variable >= '1.0'",
            "python_version",
            "(python_version)",
            "python_version >= 1.0 and (python_version)",
            '(python_version == "2.7" and os_name == "linux"',
            '(python_version == "2.7") with random text',
        ],
    )
    def test_parses_invalid(self, marker_string: str) -> None:
        with pytest.raises(InvalidMarker):
            Marker(marker_string)

    @pytest.mark.parametrize(
        ("marker_string", "expected"),
        [
            (
                'os_name == "C:\\"',
                "packaging.markers.InvalidMarker: Invalid quoted string\n"
                '    os_name == "C:\\"\n'
                "               ~~~~~^",
            ),
            (
                r'os_name == "\x"',
                "packaging.markers.InvalidMarker: Invalid quoted string\n"
                r'    os_name == "\x"'
                "\n"
                "               ~~~~^",
            ),
        ],
    )
    def test_parses_invalid_malformed_quoted_string(
        self, marker_string: str, expected: str
    ) -> None:
        with pytest.raises(InvalidMarker) as ctx:
            Marker(marker_string)
        assert ctx.exconly() == expected

    @pytest.mark.parametrize(
        ("marker_string", "expected"),
        [
            # Test the different quoting rules
            ("python_version == '2.7'", 'python_version == "2.7"'),
            ('python_version == "2.7"', 'python_version == "2.7"'),
            # Test and/or expressions
            (
                'python_version == "2.7" and os_name == "linux"',
                'python_version == "2.7" and os_name == "linux"',
            ),
            (
                'python_version == "2.7" or os_name == "linux"',
                'python_version == "2.7" or os_name == "linux"',
            ),
            (
                'python_version == "2.7" and os_name == "linux" or '
                'sys_platform == "win32"',
                'python_version == "2.7" and os_name == "linux" or '
                'sys_platform == "win32"',
            ),
            # Test nested expressions and grouping with ()
            ('(python_version == "2.7")', 'python_version == "2.7"'),
            (
                '(python_version == "2.7" and sys_platform == "win32")',
                'python_version == "2.7" and sys_platform == "win32"',
            ),
            (
                'python_version == "2.7" and (sys_platform == "win32" or '
                'sys_platform == "linux")',
                'python_version == "2.7" and (sys_platform == "win32" or '
                'sys_platform == "linux")',
            ),
        ],
    )
    def test_str_repr_eq_hash(self, marker_string: str, expected: str) -> None:
        m = Marker(marker_string)
        assert str(m) == expected
        assert repr(m) == f"<Marker({str(m)!r})>"
        # Objects created from the same string should be equal.
        assert m == Marker(marker_string)
        # Objects created from the equivalent strings should also be equal.
        assert m == Marker(expected)
        # Objects created from the same string should have the same hash.
        assert hash(Marker(marker_string)) == hash(Marker(marker_string))
        # Objects created from equivalent strings should also have the same hash.
        assert hash(Marker(marker_string)) == hash(Marker(expected))

    @pytest.mark.parametrize(
        ("example1", "example2"),
        [
            # Test trivial comparisons.
            ('python_version == "2.7"', 'python_version == "3.7"'),
            (
                'python_version == "2.7"',
                'python_version == "2.7" and os_name == "linux"',
            ),
            (
                'python_version == "2.7"',
                '(python_version == "2.7" and os_name == "linux")',
            ),
            # Test different precedence.
            (
                'python_version == "2.7" and (os_name == "linux" or '
                'sys_platform == "win32")',
                'python_version == "2.7" and os_name == "linux" or '
                'sys_platform == "win32"',
            ),
        ],
    )
    def test_different_markers_different_hashes(
        self, example1: str, example2: str
    ) -> None:
        marker1, marker2 = Marker(example1), Marker(example2)
        # Markers created from strings that are not equivalent should differ.
        assert marker1 != marker2
        # Different Marker objects should have different hashes.
        assert hash(marker1) != hash(marker2)

    def test_compare_markers_to_other_objects(self) -> None:
        # Markers should not be comparable to other kinds of objects.
        assert Marker("os_name == 'nt'") != "os_name == 'nt'"

    def test_environment_assumes_empty_extra(self) -> None:
        assert Marker('extra == "im_valid"').evaluate() is False

    def test_environment_with_extra_none(self) -> None:
        # GIVEN
        marker_str = 'extra == "im_valid"'

        # Pretend that this is dict[str, str], even though it's not. This is a
        # test for being bug-for-bug compatible with the older implementation.
        environment = cast("dict[str, str]", {"extra": None})

        # WHEN
        marker = Marker(marker_str)

        # THEN
        assert marker.evaluate(environment) is False

    def test_environment_with_no_extras(self) -> None:
        # Environment is set but no 'extra' key is present; branch only hit on
        # non-metadata context.
        marker = Marker("os_name == 'foo'")
        assert marker.evaluate({"os_name": "foo"}, context="requirement")
        assert not marker.evaluate({"os_name": "bar"}, context="requirement")

    @pytest.mark.parametrize(
        ("marker_string", "environment", "expected"),
        [
            (f"os_name == '{os.name}'", None, True),
            ("os_name == 'foo'", {"os_name": "foo"}, True),
            ("os_name == 'foo'", {"os_name": "bar"}, False),
            ("'2.7' in python_version", {"python_version": "2.7.5"}, True),
            ("'2.7' not in python_version", {"python_version": "2.7"}, False),
            (
                "os_name == 'foo' and python_version ~= '2.7.0'",
                {"os_name": "foo", "python_version": "2.7.6"},
                True,
            ),
            (
                "python_version ~= '2.7.0' and (os_name == 'foo' or os_name == 'bar')",
                {"os_name": "foo", "python_version": "2.7.4"},
                True,
            ),
            (
                "python_version ~= '2.7.0' and (os_name == 'foo' or os_name == 'bar')",
                {"os_name": "bar", "python_version": "2.7.4"},
                True,
            ),
            (
                "python_version ~= '2.7.0' and (os_name == 'foo' or os_name == 'bar')",
                {"os_name": "other", "python_version": "2.7.4"},
                False,
            ),
            ("extra == 'security'", {"extra": "quux"}, False),
            ("extra == 'security'", {"extra": "security"}, True),
            ("extra == 'SECURITY'", {"extra": "security"}, True),
            ("extra == 'security'", {"extra": "SECURITY"}, True),
            ("extra == 'pep-685-norm'", {"extra": "PEP_685...norm"}, True),
            (
                "extra == 'Different.punctuation..is...equal'",
                {"extra": "different__punctuation_is_EQUAL"},
                True,
            ),
        ],
    )
    def test_evaluates(
        self, marker_string: str, environment: dict[str, str] | None, expected: bool
    ) -> None:
        if environment is None:
            assert Marker(marker_string).evaluate() == expected
        else:
            assert Marker(marker_string).evaluate(environment) == expected

    @pytest.mark.parametrize(
        "marker_string",
        [
            "{} {} {!r}".format(*i)
            for i in itertools.product(PEP_345_VARIABLES, OPERATORS, VALUES)
        ]
        + [
            "{2!r} {1} {0}".format(*i)
            for i in itertools.product(PEP_345_VARIABLES, OPERATORS, VALUES)
        ],
    )
    def test_parses_pep345_valid(self, marker_string: str) -> None:
        Marker(marker_string)

    @pytest.mark.parametrize(
        ("marker_string", "environment", "expected"),
        [
            (f"os.name == '{os.name}'", None, True),
            ("sys.platform == 'win32'", {"sys_platform": "linux2"}, False),
            ("platform.version in 'Ubuntu'", {"platform_version": "#39"}, False),
            ("platform.machine=='x86_64'", {"platform_machine": "x86_64"}, True),
            (
                "platform.python_implementation=='Jython'",
                {"platform_python_implementation": "CPython"},
                False,
            ),
            (
                "python_version == '2.5' and platform.python_implementation!= 'Jython'",
                {"python_version": "2.7"},
                False,
            ),
        ],
    )
    def test_evaluate_pep345_markers(
        self, marker_string: str, environment: dict[str, str] | None, expected: bool
    ) -> None:
        if environment is None:
            assert Marker(marker_string).evaluate() == expected
        else:
            assert Marker(marker_string).evaluate(environment) == expected

    @pytest.mark.parametrize(
        "marker_string",
        [
            "{} {} {!r}".format(*i)
            for i in itertools.product(SETUPTOOLS_VARIABLES, OPERATORS, VALUES)
        ]
        + [
            "{2!r} {1} {0}".format(*i)
            for i in itertools.product(SETUPTOOLS_VARIABLES, OPERATORS, VALUES)
        ],
    )
    def test_parses_setuptools_legacy_valid(self, marker_string: str) -> None:
        Marker(marker_string)

    def test_evaluate_setuptools_legacy_markers(self) -> None:
        marker_string = "python_implementation=='Jython'"
        args = ({"platform_python_implementation": "CPython"},)
        assert Marker(marker_string).evaluate(*args) is False

    def test_extra_str_normalization(self) -> None:
        raw_name = "S_P__A_M"
        normalized_name = "s-p-a-m"
        lhs = f"{raw_name!r} == extra"
        rhs = f"extra == {raw_name!r}"

        assert str(Marker(lhs)) == f'"{normalized_name}" == extra'
        assert str(Marker(rhs)) == f'extra == "{normalized_name}"'

    def test_extra_compared_to_variable_not_normalized(self) -> None:
        # A variable-vs-variable atom must not be rewritten into a string
        # literal, even when one side is ``extra``.
        assert str(Marker("extra == os_name")) == "extra == os_name"
        assert str(Marker("os_name == extra")) == "os_name == extra"

    def test_nested_extra_str_normalization(self) -> None:
        marker = Marker(
            '(extra == "Foo_Bar" or extra == "Baz") and python_version >= "3"'
        )

        assert (
            str(marker)
            == '(extra == "foo-bar" or extra == "baz") and python_version >= "3"'
        )
        assert marker.evaluate({"extra": "foo-bar", "python_version": "3.12"})

    def test_python_full_version_untagged_user_provided(self) -> None:
        """A user-provided python_full_version ending with a + is also repaired."""
        assert Marker("python_full_version < '3.12'").evaluate(
            {"python_full_version": "3.11.1+"}
        )

    def test_python_full_version_untagged(self) -> None:
        with mock.patch("platform.python_version", return_value="3.11.1+"):
            assert Marker("python_full_version < '3.12'").evaluate()

    @pytest.mark.parametrize("variable", ["extras", "dependency_groups"])
    @pytest.mark.parametrize(
        ("expression", "result"),
        [
            pytest.param('"foo" in {0}', True, id="value-in-foo"),
            pytest.param('"bar" in {0}', True, id="value-in-bar"),
            pytest.param('"baz" in {0}', False, id="value-not-in"),
            pytest.param('"baz" not in {0}', True, id="value-not-in-negated"),
            pytest.param('"foo" in {0} and "bar" in {0}', True, id="and-in"),
            pytest.param('"foo" in {0} or "bar" in {0}', True, id="or-in"),
            pytest.param(
                '"baz" in {0} and "foo" in {0}', False, id="short-circuit-and"
            ),
            pytest.param('"foo" in {0} or "baz" in {0}', True, id="short-circuit-or"),
            pytest.param('"Foo" in {0}', True, id="case-sensitive"),
        ],
    )
    def test_extras_and_dependency_groups(
        self, variable: str, expression: str, result: bool
    ) -> None:
        environment = {variable: {"foo", "bar"}}
        assert Marker(expression.format(variable)).evaluate(environment) == result

    @pytest.mark.parametrize("variable", ["extras", "dependency_groups"])
    def test_extras_and_dependency_groups_disallowed(self, variable: str) -> None:
        marker = Marker(f'"foo" in {variable}')
        assert not marker.evaluate(context="lock_file")

        with pytest.raises(KeyError):
            marker.evaluate()

        with pytest.raises(KeyError):
            marker.evaluate(context="requirement")

    def test_missing_environment_key_raises_undefined_environment_name(self) -> None:
        marker = Marker('"foo" in extras')
        with pytest.raises(UndefinedEnvironmentName) as ctx:
            marker.evaluate()
        assert ctx.value.args == ("extras",)
        # UndefinedEnvironmentName subclasses KeyError, so the historical
        # bare ``except KeyError`` for a missing environment key still works.
        assert issubclass(UndefinedEnvironmentName, KeyError)
        with pytest.raises(KeyError):
            marker.evaluate()

    @pytest.mark.parametrize(
        ("marker_string", "environment", "expected"),
        [
            ('extra == "v2"', None, False),
            ('extra == "v2"', {"extra": ""}, False),
            ('extra == "v2"', {"extra": "v2"}, True),
            ('extra == "v2"', {"extra": "v2a3"}, False),
            ('extra == "v2a3"', {"extra": "v2"}, False),
            ('extra == "v2a3"', {"extra": "v2a3"}, True),
        ],
    )
    def test_version_like_equality(
        self, marker_string: str, environment: dict[str, str] | None, expected: bool
    ) -> None:
        """
        Test for issue #938: Extras are meant to be literal strings, even if
        they look like versions, and therefore should not be parsed as version.
        """
        marker = Marker(marker_string)
        assert marker.evaluate(environment) is expected


def test_and_operator_evaluates_true() -> None:
    env = {"python_version": "3.8", "os_name": "posix"}

    m = Marker('python_version >= "3.6"') & Marker('os_name == "posix"')
    assert m.evaluate(env) is True


def test_and_operator_str_equality() -> None:
    a = Marker('python_version >= "3.6" and os_name == "posix"')
    b = Marker('python_version >= "3.6"') & Marker('os_name == "posix"')
    assert a == b
    assert str(a) == str(b)


def test_or_operator_evaluates_true() -> None:
    env = {"python_version": "3.7", "os_name": "windows"}

    m = Marker('python_version < "3.6"') | Marker('os_name == "windows"')
    assert m.evaluate(env) is True


def test_or_operator_str_equality() -> None:
    a = Marker('python_version < "3.6" or os_name == "windows"')
    b = Marker('python_version < "3.6"') | Marker('os_name == "windows"')
    assert a == b
    assert str(a) == str(b)


def test_operator_rejects_non_marker() -> None:
    m = Marker('python_version >= "3.6"')
    # dunder returns NotImplemented for non-Marker
    assert m.__and__(cast("Any", "not-a-marker")) is NotImplemented
    assert m.__or__(cast("Any", 123)) is NotImplemented


def test_inplace_operators_fallback() -> None:
    m = Marker('python_version >= "3.6"')
    m &= Marker('os_name == "posix"')
    assert isinstance(m, Marker)
    assert m == Marker('python_version >= "3.6"') & Marker('os_name == "posix"')


def test_right_hand_ops_and_typeerror() -> None:
    m = Marker('python_version >= "3.6"')
    assert m.__and__(cast("Any", "x")) is NotImplemented
    with pytest.raises(TypeError):
        cast("Any", "not-a-marker") & Marker('python_version >= "3.6"')


def test_chaining_associativity_and_str() -> None:
    a = Marker(
        '(python_version >= "3.6" and os_name == "posix") '
        'and platform_system == "Linux"'
    )
    b = (
        Marker('python_version >= "3.6"')
        & Marker('os_name == "posix"')
        & Marker('platform_system == "Linux"')
    )
    assert a == b
    assert str(a) == str(b)


def test_str_preserves_nested_group_precedence() -> None:
    # A nested group must keep its parentheses so str(Marker(...)) round-trips.
    m = Marker(
        'python_version < "3.10" and '
        '((sys_platform == "linux" or sys_platform == "darwin"))'
    )
    reparsed = Marker(str(m))
    for env in (
        {"python_version": "3.12", "sys_platform": "darwin"},
        {"python_version": "3.12", "sys_platform": "linux"},
        {"python_version": "3.9", "sys_platform": "darwin"},
    ):
        assert reparsed.evaluate(env) == m.evaluate(env)


def test_hash_eq_for_combined_markers() -> None:
    assert hash(Marker('python_version >= "3.6" and os_name == "posix"')) == hash(
        Marker('python_version >= "3.6"') & Marker('os_name == "posix"')
    )


def test_evaluation_of_combined_markers() -> None:
    env = {"python_version": "3.8", "os_name": "posix", "platform_system": "Linux"}
    m = (
        Marker('python_version >= "3.6"')
        & Marker('os_name == "posix"')
        & Marker('platform_system == "Linux"')
    )
    assert m.evaluate(env) is True


@pytest.mark.parametrize(
    "marker_str",
    [
        'python_version >= "3.8"',
        'python_version >= "3.8" and os_name == "posix"',
        'python_version >= "3.8" or platform_system == "Windows"',
        'extra == "security"',
    ],
)
def test_pickle_marker_roundtrip(marker_str: str) -> None:
    # Make sure equality and str() work between a pickle/unpickle round trip.
    m = Marker(marker_str)
    loaded = pickle.loads(pickle.dumps(m))
    assert loaded == m
    assert str(loaded) == str(m)


def test_pickle_marker_setstate_rejects_invalid_state() -> None:
    # Cover the TypeError branches in __setstate__ for invalid input.
    m = Marker.__new__(Marker)
    with pytest.raises(TypeError, match="Cannot restore Marker"):
        m.__setstate__(12345)
    with pytest.raises(TypeError, match="Cannot restore Marker"):
        m.__setstate__((1, 2, 3))  # Wrong tuple length


# Pickle bytes generated with packaging==26.1, Python 3.13.1, pickle protocol 2.
# Format: __slots__ (no __getstate__), state is (None, {slot: value}).
_PACKAGING_26_1_PICKLE_MARKER_PYTHON_VERSION_GE_3_8 = (
    b"\x80\x02cpackaging.markers\nMarker\nq\x00)\x81q\x01N}q\x02X\x08\x00"
    b"\x00\x00_markersq\x03]q\x04cpackaging._parser\nVariable\nq\x05)\x81"
    b"q\x06N}q\x07X\x05\x00\x00\x00valueq\x08X\x0e\x00\x00\x00python_vers"
    b"ionq\ts\x86q\nbcpackaging._parser\nOp\nq\x0b)\x81q\x0cN}q\rh\x08X\x02"
    b"\x00\x00\x00>=q\x0es\x86q\x0fbcpackaging._parser\nValue\nq\x10)\x81q"
    b"\x11N}q\x12h\x08X\x03\x00\x00\x003.8q\x13s\x86q\x14b\x87q\x15as\x86"
    b"q\x16b."
)


# Pickle bytes generated with packaging==26.0, Python 3.13.1, pickle protocol 2.
# Format: __slots__ (no __getstate__), state is plain __dict__.
_PACKAGING_26_0_PICKLE_MARKER_PYTHON_VERSION_GE_3_8 = (
    b"\x80\x02cpackaging.markers\nMarker\nq\x00)\x81q\x01}q\x02X\x08\x00\x00"
    b"\x00_markersq\x03]q\x04cpackaging._parser\nVariable\nq\x05)\x81q\x06N}"
    b"q\x07X\x05\x00\x00\x00valueq\x08X\x0e\x00\x00\x00python_versionq\ts\x86"
    b"q\nbcpackaging._parser\nOp\nq\x0b)\x81q\x0cN}q\rh\x08X\x02\x00\x00"
    b"\x00>=q\x0es\x86q\x0fbcpackaging._parser\nValue\nq\x10)\x81q\x11N}q\x12"
    b"h\x08X\x03\x00\x00\x003.8q\x13s\x86q\x14b\x87q\x15asb."
)

# Format: __slots__ with Node objects using __dict__ format (packaging <= 25.0).
# Now loadable because Node classes have __getstate__/__setstate__.
_PACKAGING_25_0_PICKLE_MARKER_PYTHON_VERSION_GE_3_8 = (
    b"\x80\x02cpackaging.markers\nMarker\nq\x00)\x81q\x01}q\x02X\x08\x00\x00"
    b"\x00_markersq\x03]q\x04cpackaging._parser\nVariable\nq\x05)\x81q\x06}q\x07"
    b"X\x05\x00\x00\x00valueq\x08X\x0e\x00\x00\x00python_versionq\tsbcpackaging"
    b"._parser\nOp\nq\n)\x81q\x0b}q\x0ch\x08X\x02\x00\x00\x00>=q\rsbcpackaging"
    b"._parser\nValue\nq\x0e)\x81q\x0f}q\x10h\x08X\x03\x00\x00\x003.8q\x11sb\x87"
    b"q\x12asb."
)


def test_pickle_marker_old_format_loads() -> None:
    # Verify that Marker pickles created with packaging <= 26.1 (__slots__,
    # no __getstate__) can be loaded and produce correct Marker objects.
    m = pickle.loads(_PACKAGING_26_1_PICKLE_MARKER_PYTHON_VERSION_GE_3_8)
    assert isinstance(m, Marker)
    assert str(m) == 'python_version >= "3.8"'
    assert m == Marker('python_version >= "3.8"')


def test_pickle_marker_26_0_format_loads() -> None:
    # Verify that Marker pickles created with packaging 26.0 (plain __dict__)
    # can be loaded and produce correct Marker objects.
    m = pickle.loads(_PACKAGING_26_0_PICKLE_MARKER_PYTHON_VERSION_GE_3_8)
    assert isinstance(m, Marker)
    assert str(m) == 'python_version >= "3.8"'
    assert m == Marker('python_version >= "3.8"')


def test_pickle_marker_25_0_format_loads() -> None:
    # Verify that Marker pickles created with packaging 25.0 (with Node __dict__)
    # can now be loaded thanks to __getstate__/__setstate__ in Node classes.
    m = pickle.loads(_PACKAGING_25_0_PICKLE_MARKER_PYTHON_VERSION_GE_3_8)
    assert isinstance(m, Marker)
    assert str(m) == 'python_version >= "3.8"'
    assert m == Marker('python_version >= "3.8"')


def test_pickle_node_roundtrip() -> None:
    # Cover Node.__getstate__ and Node.__setstate__ with the new string format.
    for node in (Variable("python_version"), Value("3.8"), Op(">=")):
        loaded = pickle.loads(pickle.dumps(node))
        assert loaded.value == node.value
        assert str(loaded) == str(node)


def test_pickle_node_setstate_rejects_invalid_state() -> None:
    # Cover the TypeError branch in Node.__setstate__ for invalid input.
    node = Variable.__new__(Variable)
    with pytest.raises(TypeError, match="Cannot restore Variable"):
        node.__setstate__(12345)

    node2 = Variable.__new__(Variable)
    with pytest.raises(TypeError, match="Cannot restore Variable"):
        node2.__setstate__((1, 2, 3))  # Wrong tuple length

    # Cover the legacy tuple branch where slot_dict doesn't have "value".
    node3 = Variable.__new__(Variable)
    with pytest.raises(TypeError, match="Cannot restore Variable"):
        node3.__setstate__((None, {"wrong_key": "foo"}))

    # Cover the legacy tuple branch where slot_dict has "value" but it's not a str.
    node4 = Variable.__new__(Variable)
    with pytest.raises(TypeError, match="Cannot restore Variable value from 123"):
        node4.__setstate__((None, {"value": 123}))

    # Cover the legacy dict branch where "value" exists but it's not a str.
    node5 = Value.__new__(Value)
    with pytest.raises(TypeError, match="Cannot restore Value value from 456"):
        node5.__setstate__({"value": 456})

    # Cover the legacy dict branch on Op (different subclass to ensure coverage).
    node6 = Op.__new__(Op)
    with pytest.raises(TypeError, match="Cannot restore Op value from 789"):
        node6.__setstate__({"value": 789})


def test_pickle_marker_setstate_legacy_slot_dict_without_markers_key() -> None:
    # Cover Marker.__setstate__ legacy tuple branch where slot_dict has no "_markers".
    m = Marker.__new__(Marker)
    with pytest.raises(TypeError, match="Cannot restore Marker"):
        m.__setstate__((None, {"other_key": "value"}))


def test_pickle_marker_setstate_rejects_invalid_markers_type() -> None:
    # Cover the dict branch where "_markers" exists but is not a list.
    m1 = Marker.__new__(Marker)
    with pytest.raises(TypeError, match="Cannot restore Marker"):
        m1.__setstate__({"_markers": "not a list"})

    # Cover the tuple branch where "_markers" exists but is not a list.
    m2 = Marker.__new__(Marker)
    with pytest.raises(TypeError, match="Cannot restore Marker"):
        m2.__setstate__((None, {"_markers": "not a list"}))


def test_pickle_marker_setstate_rejects_invalid_marker_string() -> None:
    # Cover the string branch where parsing raises ParserSyntaxError.
    m = Marker.__new__(Marker)
    with pytest.raises(TypeError, match="Cannot restore Marker"):
        m.__setstate__("this is not a valid marker")
