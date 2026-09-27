# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the BSD License. See the LICENSE file in the root of this repository
# for complete details.

from __future__ import annotations

import itertools
import operator
import pickle
import re
import sys
import typing

import pytest

from packaging.specifiers import InvalidSpecifier, Specifier, SpecifierSet
from packaging.version import InvalidVersion, Version, parse

from .test_version import VERSIONS

if typing.TYPE_CHECKING:
    from collections.abc import Callable

LEGACY_SPECIFIERS = [
    "==2.1.0.3",
    "!=2.2.0.5",
    "<=5",
    ">=7.9a1",
    "<1.0.dev1",
    ">2.0.post1",
]

SPECIFIERS = [
    "~=2.0",
    "==2.1.*",
    "==2.1.0.3",
    "!=2.2.*",
    "!=2.2.0.5",
    "<=5",
    ">=7.9a1",
    "<1.0.dev1",
    ">2.0.post1",
]


class TestSpecifier:
    @pytest.mark.parametrize("specifier", SPECIFIERS)
    def test_specifiers_valid(self, specifier: str) -> None:
        Specifier(specifier)

    def test_match_args(self) -> None:
        assert Specifier.__match_args__ == ("_str",)
        assert Specifier(">=1.0")._str == ">=1.0"

    @pytest.mark.parametrize(
        "specifier",
        [
            # Operator-less specifier
            "2.0",
            # Invalid operator
            "=>2.0",
            # Version-less specifier
            "==",
            # Local segment on operators which don't support them
            "~=1.0+5",
            ">=1.0+deadbeef",
            "<=1.0+abc123",
            ">1.0+watwat",
            "<1.0+1.0",
            # Prefix matching on operators which don't support them
            "~=1.0.*",
            ">=1.0.*",
            "<=1.0.*",
            ">1.0.*",
            "<1.0.*",
            # Combination of local and prefix matching on operators which do
            # support one or the other
            "==1.0.*+5",
            "!=1.0.*+deadbeef",
            # Prefix matching cannot be used with a pre-release, post-release,
            # dev or local version
            "==2.0a1.*",
            "!=2.0a1.*",
            "==2.0.post1.*",
            "!=2.0.post1.*",
            "==2.0.dev1.*",
            "!=2.0.dev1.*",
            "==1.0+5.*",
            "!=1.0+deadbeef.*",
            # Prefix matching must appear at the end
            "==1.0.*.5",
            # Compatible operator requires 2 digits in the release operator
            "~=1",
            # Cannot use a prefix matching after a .devN version
            "==1.0.dev1.*",
            "!=1.0.dev1.*",
            # Local segment with a non-ASCII letter that matches regex '[a-z]'
            # when re.IGNORECASE is in force and re.ASCII is not (issue #469)
            "==1.2+\u0130",
            "==1.2+\u0130\u0131\u017fK",
        ],
    )
    def test_specifiers_invalid(self, specifier: str) -> None:
        with pytest.raises(InvalidSpecifier):
            Specifier(specifier)

    @pytest.mark.parametrize(
        "version",
        [
            # Various development release incarnations
            "1.0dev",
            "1.0.dev",
            "1.0dev1",
            "1.0-dev",
            "1.0-dev1",
            "1.0DEV",
            "1.0.DEV",
            "1.0DEV1",
            "1.0.DEV1",
            "1.0-DEV",
            "1.0-DEV1",
            # Various alpha incarnations
            "1.0a",
            "1.0.a",
            "1.0.a1",
            "1.0-a",
            "1.0-a1",
            "1.0alpha",
            "1.0.alpha",
            "1.0.alpha1",
            "1.0-alpha",
            "1.0-alpha1",
            "1.0A",
            "1.0.A",
            "1.0.A1",
            "1.0-A",
            "1.0-A1",
            "1.0ALPHA",
            "1.0.ALPHA",
            "1.0.ALPHA1",
            "1.0-ALPHA",
            "1.0-ALPHA1",
            # Various beta incarnations
            "1.0b",
            "1.0.b",
            "1.0.b1",
            "1.0-b",
            "1.0-b1",
            "1.0beta",
            "1.0.beta",
            "1.0.beta1",
            "1.0-beta",
            "1.0-beta1",
            "1.0B",
            "1.0.B",
            "1.0.B1",
            "1.0-B",
            "1.0-B1",
            "1.0BETA",
            "1.0.BETA",
            "1.0.BETA1",
            "1.0-BETA",
            "1.0-BETA1",
            # Various release candidate incarnations
            "1.0c",
            "1.0.c",
            "1.0.c1",
            "1.0-c",
            "1.0-c1",
            "1.0rc",
            "1.0.rc",
            "1.0.rc1",
            "1.0-rc",
            "1.0-rc1",
            "1.0C",
            "1.0.C",
            "1.0.C1",
            "1.0-C",
            "1.0-C1",
            "1.0RC",
            "1.0.RC",
            "1.0.RC1",
            "1.0-RC",
            "1.0-RC1",
            # Various post release incarnations
            "1.0post",
            "1.0.post",
            "1.0post1",
            "1.0-post",
            "1.0-post1",
            "1.0POST",
            "1.0.POST",
            "1.0POST1",
            "1.0.POST1",
            "1.0-POST",
            "1.0-POST1",
            "1.0-5",
            # Local version case insensitivity
            "1.0+AbC",
            # Integer Normalization
            "1.01",
            "1.0a05",
            "1.0b07",
            "1.0c056",
            "1.0rc09",
            "1.0.post000",
            "1.1.dev09000",
            "00!1.2",
            "0100!0.0",
            # Various other normalizations
            "v1.0",
            "  \r \f \v v1.0\t\n",
        ],
    )
    def test_specifiers_normalized(self, version: str) -> None:
        if "+" not in version:
            ops = ["~=", "==", "!=", "<=", ">=", "<", ">"]
        else:
            ops = ["==", "!="]

        for op in ops:
            Specifier(op + version)

    @pytest.mark.parametrize(
        ("specifier", "expected"),
        [
            # Single item specifiers should just be reflexive
            ("!=2.0", "!=2.0"),
            ("<2.0", "<2.0"),
            ("<=2.0", "<=2.0"),
            ("==2.0", "==2.0"),
            (">2.0", ">2.0"),
            (">=2.0", ">=2.0"),
            ("~=2.0", "~=2.0"),
            # Spaces should be removed
            ("< 2", "<2"),
        ],
    )
    def test_specifiers_str_and_repr(self, specifier: str, expected: str) -> None:
        spec = Specifier(specifier)

        assert str(spec) == expected
        assert repr(spec) == f"<Specifier({expected!r})>"

    @pytest.mark.parametrize("specifier", SPECIFIERS)
    def test_specifiers_hash(self, specifier: str) -> None:
        assert hash(Specifier(specifier)) == hash(Specifier(specifier))

    @pytest.mark.parametrize(
        ("left", "right", "op"),
        list(
            itertools.chain.from_iterable(
                # Verify that the equal (==) operator works correctly
                [[(x, x, operator.eq) for x in SPECIFIERS]]
                +
                # Verify that the not equal (!=) operator works correctly
                [
                    [(x, y, operator.ne) for j, y in enumerate(SPECIFIERS) if i != j]
                    for i, x in enumerate(SPECIFIERS)
                ]
            )
        ),
    )
    def test_comparison_true(
        self,
        left: str,
        right: str,
        op: typing.Callable[[Specifier | str, Specifier | str], bool],
    ) -> None:
        assert op(Specifier(left), Specifier(right))
        assert op(left, Specifier(right))
        assert op(Specifier(left), right)

    @pytest.mark.parametrize(("left", "right"), [("==2.8.0", "==2.8")])
    def test_comparison_canonicalizes(self, left: str, right: str) -> None:
        assert Specifier(left) == Specifier(right)
        assert left == Specifier(right)
        assert Specifier(left) == right

    @pytest.mark.parametrize(
        ("left", "right", "op"),
        list(
            itertools.chain.from_iterable(
                # Verify that the equal (==) operator works correctly
                [[(x, x, operator.ne) for x in SPECIFIERS]]
                +
                # Verify that the not equal (!=) operator works correctly
                [
                    [(x, y, operator.eq) for j, y in enumerate(SPECIFIERS) if i != j]
                    for i, x in enumerate(SPECIFIERS)
                ]
            )
        ),
    )
    def test_comparison_false(
        self,
        left: str,
        right: str,
        op: typing.Callable[[Specifier | str, Specifier | str], bool],
    ) -> None:
        assert not op(Specifier(left), Specifier(right))
        assert not op(left, Specifier(right))
        assert not op(Specifier(left), right)

    def test_comparison_non_specifier(self) -> None:
        assert Specifier("==1.0") != 12
        assert not Specifier("==1.0") == 12
        assert Specifier("==1.0") != "12"
        assert not Specifier("==1.0") == "12"

    @pytest.mark.parametrize(
        ("version", "spec_str", "expected"),
        [
            (v, s, True)
            for v, s in [
                # Test the equality operation
                ("2.0", "==2"),
                ("2.0", "==2.0"),
                ("2.0", "==2.0.0"),
                ("2.0+deadbeef", "==2"),
                ("2.0+deadbeef", "==2.0"),
                ("2.0+deadbeef", "==2.0.0"),
                ("2.0+deadbeef", "==2+deadbeef"),
                ("2.0+deadbeef", "==2.0+deadbeef"),
                ("2.0+deadbeef", "==2.0.0+deadbeef"),
                ("2.0+deadbeef.0", "==2.0.0+deadbeef.00"),
                # Test the equality operation with a prefix
                ("2.dev1", "==2.*"),
                ("2a1", "==2.*"),
                ("2a1.post1", "==2.*"),
                ("2b1", "==2.*"),
                ("2b1.dev1", "==2.*"),
                ("2c1", "==2.*"),
                ("2c1.post1.dev1", "==2.*"),
                ("2c1.post1.dev1", "==2.0.*"),
                ("2rc1", "==2.*"),
                ("2rc1", "==2.0.*"),
                ("2", "==2.*"),
                ("2", "==2.0.*"),
                ("2", "==2.0.0.*"),
                ("2", "==0!2.*"),
                ("0!2", "==2.*"),
                ("2.0", "==2.*"),
                ("2.0.0", "==2.*"),
                ("2.0.0.0", "==2.0.*"),
                ("2.1+local.version", "==2.1.*"),
                # Test the in-equality operation
                ("2.1", "!=2"),
                ("2.1", "!=2.0"),
                ("2.0.1", "!=2"),
                ("2.0.1", "!=2.0"),
                ("2.0.1", "!=2.0.0"),
                ("2.0", "!=2.0+deadbeef"),
                # Test the in-equality operation with a prefix
                ("2.0", "!=3.*"),
                ("2.1", "!=2.0.*"),
                ("3", "!=2.0.0.*"),
                ("2.1.0.0", "!=2.0.*"),
                # Test the greater than equal operation
                ("2.0", ">=2"),
                ("2.0", ">=2.0"),
                ("2.0", ">=2.0.0"),
                ("2.0.post1", ">=2"),
                ("2.0.post1.dev1", ">=2"),
                ("3", ">=2"),
                ("3.0.0a8", ">=3.0.0a7"),
                # Test the less than equal operation
                ("2.0", "<=2"),
                ("2.0", "<=2.0"),
                ("2.0", "<=2.0.0"),
                ("2.0.dev1", "<=2"),
                ("2.0a1", "<=2"),
                ("2.0a1.dev1", "<=2"),
                ("2.0b1", "<=2"),
                ("2.0b1.post1", "<=2"),
                ("2.0c1", "<=2"),
                ("2.0c1.post1.dev1", "<=2"),
                ("2.0rc1", "<=2"),
                ("1", "<=2"),
                ("3.0.0a7", "<=3.0.0a8"),
                # Test the greater than operation
                ("3", ">2"),
                ("2.1", ">2.0"),
                ("2.0.1", ">2"),
                ("2.1.post1", ">2"),
                ("2.1+local.version", ">2"),
                ("3.0.0a8", ">3.0.0a7"),
                # Test the less than operation
                ("1", "<2"),
                ("2.0", "<2.1"),
                ("2.0.dev0", "<2.1"),
                ("3.0.0a7", "<3.0.0a8"),
                # Test the compatibility operation
                ("1", "~=1.0"),
                ("1.0.1", "~=1.0"),
                ("1.1", "~=1.0"),
                ("1.9999999", "~=1.0"),
                ("1.1", "~=1.0a1"),
                ("2022.01.01", "~=2022.01.01"),
                # Test that epochs are handled sanely
                ("2!1.0", "~=2!1.0"),
                ("2!1.0", "==2!1.*"),
                ("2!1.0", "==2!1.0"),
                ("2!1.0", "!=1.0"),
                ("2!1.0.0", "==2!1.0.0.0.*"),
                ("2!1.0.0", "==2!1.0.*"),
                ("2!1.0.0", "==2!1.*"),
                ("1.0", "!=2!1.0"),
                ("1.0", "<=2!0.1"),
                ("2!1.0", ">=2.0"),
                ("1.0", "<2!0.1"),
                ("2!1.0", ">2.0"),
                # Test some normalization rules
                ("2.0.5", ">2.0dev"),
                # Test local versions with pre/dev/post segments and >
                # (verifies _public_version keeps pre/dev/post in the guard)
                ("1.0+local", ">1.0.dev1"),
                ("4.1.0a2.dev1235+local", ">4.1.0a2.dev1234"),
                ("1.0a2+local", ">1.0a1"),
                ("1.0b2+local", ">1.0b1"),
                ("1.0rc2+local", ">1.0rc1"),
                ("1.0.post2+local", ">1.0.post1"),
                ("1.0.dev2+local", ">1.0.dev1"),
                ("1.0a1.dev2+local", ">1.0a1.dev1"),
                ("1.0.post1.dev2+local", ">1.0.post1.dev1"),
            ]
        ]
        + [
            (v, s, False)
            for v, s in [
                # Test the equality operation
                ("2.1", "==2"),
                ("2.1", "==2.0"),
                ("2.1", "==2.0.0"),
                ("2.0", "==2.0+deadbeef"),
                # Test the equality operation with a prefix
                ("2.0", "==3.*"),
                ("2.1", "==2.0.*"),
                ("3", "==2.0.0.*"),
                ("2.1.0.0", "==2.0.*"),
                # Test the in-equality operation
                ("2.0", "!=2"),
                ("2.0", "!=2.0"),
                ("2.0", "!=2.0.0"),
                ("2.0+deadbeef", "!=2"),
                ("2.0+deadbeef", "!=2.0"),
                ("2.0+deadbeef", "!=2.0.0"),
                ("2.0+deadbeef", "!=2+deadbeef"),
                ("2.0+deadbeef", "!=2.0+deadbeef"),
                ("2.0+deadbeef", "!=2.0.0+deadbeef"),
                ("2.0+deadbeef.0", "!=2.0.0+deadbeef.00"),
                # Test the in-equality operation with a prefix
                ("2.dev1", "!=2.*"),
                ("2a1", "!=2.*"),
                ("2a1.post1", "!=2.*"),
                ("2b1", "!=2.*"),
                ("2b1.dev1", "!=2.*"),
                ("2c1", "!=2.*"),
                ("2c1.post1.dev1", "!=2.*"),
                ("2c1.post1.dev1", "!=2.0.*"),
                ("2rc1", "!=2.*"),
                ("2rc1", "!=2.0.*"),
                ("2", "!=2.*"),
                ("2", "!=2.0.*"),
                ("2", "!=2.0.0.*"),
                ("2.0", "!=2.*"),
                ("2.0.0", "!=2.*"),
                ("2.0.0.0", "!=2.0.*"),
                # Test the greater than equal operation
                ("2.0.dev1", ">=2"),
                ("2.0a1", ">=2"),
                ("2.0a1.dev1", ">=2"),
                ("2.0b1", ">=2"),
                ("2.0b1.post1", ">=2"),
                ("2.0c1", ">=2"),
                ("2.0c1.post1.dev1", ">=2"),
                ("2.0rc1", ">=2"),
                ("1", ">=2"),
                # Test the less than equal operation
                ("2.0.post1", "<=2"),
                ("2.0.post1.dev1", "<=2"),
                ("3", "<=2"),
                # Test the greater than operation
                ("1", ">2"),
                ("2.0.dev1", ">2"),
                ("2.0a1", ">2"),
                ("2.0a1.post1", ">2"),
                ("2.0b1", ">2"),
                ("2.0b1.dev1", ">2"),
                ("2.0c1", ">2"),
                ("2.0c1.post1.dev1", ">2"),
                ("2.0rc1", ">2"),
                ("2.0", ">2"),
                ("2.0.post1", ">2"),
                ("2.0.post1.dev1", ">2"),
                ("2.0+local.version", ">2"),
                ("4.1.0a2.dev1234+local", ">4.1.0a2.dev1234"),
                # Test local versions with pre/dev/post segments and >
                # (local variant of the exact spec version must not match)
                ("1.0a1+local", ">1.0a1"),
                ("1.0b1+local", ">1.0b1"),
                ("1.0rc1+local", ">1.0rc1"),
                ("1.0.post1+local", ">1.0.post1"),
                ("1.0.dev1+local", ">1.0.dev1"),
                ("1.0a1.dev1+local", ">1.0a1.dev1"),
                ("1.0.post1.dev1+local", ">1.0.post1.dev1"),
                # Test the less than operation
                ("2.0.dev1", "<2"),
                ("2.0a1", "<2"),
                ("2.0a1.post1", "<2"),
                ("2.0b1", "<2"),
                ("2.0b2.dev1", "<2"),
                ("2.0c1", "<2"),
                ("2.0c1.post1.dev1", "<2"),
                ("2.0rc1", "<2"),
                ("2.0", "<2"),
                ("2.post1", "<2"),
                ("2.post1.dev1", "<2"),
                ("3", "<2"),
                # Test the compatibility operation
                ("2.0", "~=1.0"),
                ("1.1.0", "~=1.0.0"),
                ("1.1.post1", "~=1.0.0"),
                # Test that epochs are handled sanely
                ("1.0", "~=2!1.0"),
                ("2!1.0", "~=1.0"),
                ("2!1.0", "==1.0"),
                ("1.0", "==2!1.0"),
                ("2!1.0", "==1.0.0.*"),
                ("1.0", "==2!1.0.0.*"),
                ("2!1.0", "==1.*"),
                ("1.0", "==2!1.*"),
                ("2!1.0", "!=2!1.0"),
            ]
        ],
    )
    def test_specifiers(self, version: str, spec_str: str, expected: bool) -> None:
        spec = Specifier(spec_str, prereleases=True)
        # The range conversion must answer membership identically.
        version_range = SpecifierSet(spec_str, prereleases=True).to_range()

        if expected:
            # Test that the plain string form works
            assert version in spec
            assert spec.contains(version)

            # Test that the version instance form works
            assert Version(version) in spec
            assert spec.contains(Version(version))

            assert version in version_range
            assert Version(version) in version_range
        else:
            # Test that the plain string form works
            assert version not in spec
            assert not spec.contains(version)

            # Test that the version instance form works
            assert Version(version) not in spec
            assert not spec.contains(Version(version))

            assert version not in version_range
            assert Version(version) not in version_range

    @pytest.mark.parametrize(
        ("spec_str", "version", "expected"),
        [
            ("==1.0", "not a valid version", False),
            ("==1.*", "not a valid version", False),
            (">=1.0", "not a valid version", False),
            (">1.0", "not a valid version", False),
            ("<=1.0", "not a valid version", False),
            ("<1.0", "not a valid version", False),
            ("~=1.0", "not a valid version", False),
            ("!=1.0", "not a valid version", False),
            ("!=1.*", "not a valid version", False),
            # Test with arbitrary equality (===)
            ("===invalid", "invalid", True),
            ("===foobar", "invalid", False),
        ],
    )
    def test_invalid_version(self, spec_str: str, version: str, expected: bool) -> None:
        spec = Specifier(spec_str, prereleases=True)
        assert spec.contains(version) == expected
        # The ``===`` carve-out range answers via the literal match.
        version_range = SpecifierSet(spec_str, prereleases=True).to_range()
        assert (version in version_range) == expected

    @pytest.mark.parametrize(
        (
            "specifier",
            "initial_prereleases",
            "set_prereleases",
            "version",
            "initial_contains",
            "final_contains",
        ),
        [
            (">1.0", None, True, "1.0.dev1", False, False),
            # Setting prereleases to True explicitly includes prerelease versions
            (">1.0", None, True, "2.0.dev1", True, True),
            (">1.0", False, True, "2.0.dev1", False, True),
            # Setting prereleases to False explicitly excludes prerelease versions
            (">1.0", None, False, "2.0.dev1", True, False),
            # Setting prereleases to None falls back to default behavior
            (">1.0", True, None, "2.0.dev1", True, True),
            (">1.0", False, None, "2.0.dev1", False, True),
            # Different specifiers with prerelease versions
            (">=2.0.dev1", None, True, "2.0a1", True, True),
            (">=2.0.dev1", None, False, "2.0a1", True, False),
            # Alpha/beta/rc/dev variations
            (">1.0", None, True, "2.0a1", True, True),
            (">1.0", None, True, "2.0b1", True, True),
            (">1.0", None, True, "2.0rc1", True, True),
            # Edge cases
            ("==2.0.*", None, True, "2.0.dev1", True, True),
            ("==2.0.*", None, False, "2.0.dev1", True, False),
            # Specifiers that already include prereleases implicitly
            ("<1.0.dev1", None, False, "0.9.dev1", True, False),
            (">1.0.dev1", None, None, "1.1.dev1", True, True),
            # Multiple changes to the prereleases setting
            (">1.0", True, False, "2.0.dev1", True, False),
        ],
    )
    def test_specifier_prereleases_set(
        self,
        specifier: str,
        initial_prereleases: bool | None,
        set_prereleases: bool | None,
        version: str,
        initial_contains: bool,
        final_contains: bool,
    ) -> None:
        """Test setting prereleases property."""
        spec = Specifier(specifier, prereleases=initial_prereleases)

        assert (version in spec) == initial_contains
        assert spec.contains(version) == initial_contains

        spec.prereleases = set_prereleases

        assert (version in spec) == final_contains
        assert spec.contains(version) == final_contains

    @pytest.mark.parametrize(
        ("version", "spec_str", "expected"),
        [
            ("1.0.0", "===1.0", False),
            ("1.0.dev0", "===1.0", False),
            # Test identity comparison by itself
            ("1.0", "===1.0", True),
            ("1.0.dev0", "===1.0.dev0", True),
            # Test that local versions don't match
            ("1.0+downstream1", "===1.0", False),
            ("1.0", "===1.0+downstream1", False),
            # Test with arbitrary (non-version) strings
            ("foobar", "===foobar", True),
            ("foobar", "===baz", False),
            # Test case insensitivity for pre-release versions
            ("1.0a1", "===1.0a1", True),
            ("1.0A1", "===1.0A1", True),
            ("1.0a1", "===1.0A1", True),
            ("1.0A1", "===1.0a1", True),
            # Test case insensitivity for beta versions
            ("1.0b1", "===1.0b1", True),
            ("1.0B1", "===1.0B1", True),
            ("1.0b1", "===1.0B1", True),
            ("1.0B1", "===1.0b1", True),
            # Test case insensitivity for release candidate versions
            ("1.0rc1", "===1.0rc1", True),
            ("1.0RC1", "===1.0RC1", True),
            ("1.0rc1", "===1.0RC1", True),
            ("1.0RC1", "===1.0rc1", True),
            # Test case insensitivity for post-release versions
            ("1.0.post1", "===1.0.post1", True),
            ("1.0.POST1", "===1.0.POST1", True),
            ("1.0.post1", "===1.0.POST1", True),
            ("1.0.POST1", "===1.0.post1", True),
            # Test case insensitivity for dev versions
            ("1.0.dev1", "===1.0.dev1", True),
            ("1.0.DEV1", "===1.0.DEV1", True),
            ("1.0.dev1", "===1.0.DEV1", True),
            ("1.0.DEV1", "===1.0.dev1", True),
            # Test case insensitivity with local versions
            ("1.0+local", "===1.0+local", True),
            ("1.0+LOCAL", "===1.0+LOCAL", True),
            ("1.0+local", "===1.0+LOCAL", True),
            ("1.0+LOCAL", "===1.0+local", True),
            ("1.0+abc.def", "===1.0+abc.def", True),
            ("1.0+ABC.DEF", "===1.0+ABC.DEF", True),
            ("1.0+abc.def", "===1.0+ABC.DEF", True),
            ("1.0+ABC.DEF", "===1.0+abc.def", True),
            # Test case insensitivity with mixed case letters in local
            ("1.0+AbC", "===1.0+AbC", True),
            ("1.0+AbC", "===1.0+abc", True),
            ("1.0+AbC", "===1.0+ABC", True),
            # Test complex cases with multiple segments
            ("1.0a1.post2.dev3", "===1.0a1.post2.dev3", True),
            ("1.0A1.POST2.DEV3", "===1.0A1.POST2.DEV3", True),
            ("1.0a1.post2.dev3", "===1.0A1.POST2.DEV3", True),
            ("1.0A1.POST2.DEV3", "===1.0a1.post2.dev3", True),
            # Test case insensitivity of non-PEP 440 versions
            ("lolwat", "===LOLWAT", True),
            ("lolwat", "===LoLWaT", True),
            ("LOLWAT", "===lolwat", True),
            ("LoLWaT", "===lOlwAt", True),
        ],
    )
    def test_arbitrary_equality(
        self, version: str, spec_str: str, expected: bool
    ) -> None:
        spec = Specifier(spec_str)
        assert spec.contains(version) == expected

    @pytest.mark.parametrize(
        ("spec_str", "version", "expected"),
        [
            # Zero padding: unnormalized spec vs string/Version
            # Strings preserve their original form, so "1.01" != "1.1"
            ("===1.1", "1.01", False),
            ("===1.01", "1.1", False),
            ("===1.01", "1.01", True),
            ("===1.1", "1.1", True),
            # Version objects are normalized, so Version("1.01") -> "1.1"
            ("===1.1", Version("1.01"), True),
            ("===1.1", Version("1.1"), True),
            ("===1.01", Version("1.01"), False),
            ("===1.01", Version("1.1"), False),
            # Prerelease separator normalization (issue #766)
            # "1.a1" is valid PEP 440, normalizes to "1a1"
            ("===1.a1", "1.a1", True),
            ("===1a1", "1.a1", False),
            ("===1.a1", "1a1", False),
            ("===1a1", "1a1", True),
            ("===1.a1", Version("1.a1"), False),
            ("===1a1", Version("1.a1"), True),
            # Epoch normalization: "0!1.0" normalizes to "1.0"
            ("===0!1.0", "0!1.0", True),
            ("===0!1.0", "1.0", False),
            ("===1.0", "0!1.0", False),
            ("===0!1.0", Version("1.0"), False),
            ("===1.0", Version("0!1.0"), True),
            # Leading zeros in release segments
            ("===01.0", "01.0", True),
            ("===01.0", "1.0", False),
            ("===1.0", "01.0", False),
            ("===01.0", Version("1.0"), False),
            ("===1.0", Version("01.0"), True),
            # Post-release normalization: "post" vs "-" separator
            ("===1.0.post1", "1.0.post1", True),
            ("===1.0-1", "1.0-1", True),
            ("===1.0-1", "1.0.post1", False),
            ("===1.0.post1", "1.0-1", False),
            ("===1.0-1", Version("1.0.post1"), False),
            ("===1.0.post1", Version("1.0-1"), True),
            # Dev normalization
            ("===1.0.dev01", "1.0.dev01", True),
            ("===1.0.dev01", "1.0.dev1", False),
            ("===1.0.dev1", "1.0.dev01", False),
            ("===1.0.dev01", Version("1.0.dev1"), False),
            ("===1.0.dev1", Version("1.0.dev01"), True),
        ],
    )
    def test_arbitrary_equality_normalization(
        self, spec_str: str, version: str | Version, expected: bool
    ) -> None:
        spec = Specifier(spec_str, prereleases=True)
        assert spec.contains(version) == expected

    @pytest.mark.parametrize(
        ("specifier", "expected"),
        [
            ("==1.0", False),
            (">=1.0", False),
            ("<=1.0", False),
            ("~=1.0", False),
            ("<1.0", False),
            (">1.0", False),
            ("<1.0.dev1", True),
            (">1.0.dev1", True),
            ("!=1.0.dev1", False),
            ("==1.0.*", False),
            ("==1.0.dev1", True),
            (">=1.0.dev1", True),
            ("<=1.0.dev1", True),
            ("~=1.0.dev1", True),
        ],
    )
    def test_specifier_prereleases_detection(
        self, specifier: str, expected: bool
    ) -> None:
        assert Specifier(specifier).prereleases == expected

    @pytest.mark.parametrize(
        ("specifier", "version", "spec_pre", "contains_pre", "expected"),
        [
            (">=1.0", "2.0.dev1", None, None, True),
            (">=2.0.dev1", "2.0a1", None, None, True),
            ("==2.0.*", "2.0a1.dev1", None, None, True),
            ("<=2.0", "1.0.dev1", None, None, True),
            ("<=2.0.dev1", "1.0a1", None, None, True),
            ("<2.0", "2.0a1", None, None, False),
            ("<2.0a2", "2.0a1", None, None, True),
            # >V.devN: post-releases of V.devN itself are excluded
            # (V.devN can't have post-releases in PEP 440, so nothing
            # to exclude; these just confirm ordering still works)
            (">1.0.dev1", "1.0.dev0", None, None, False),
            (">1.0.dev1", "1.0.dev2", None, None, True),
            # >V.devN: post-releases of the base release are NOT
            # post-releases of V.devN, so they are accepted
            (">1.0.dev1", "1.0.post0", None, None, True),
            (">1.0.dev1", "1.0.post1", None, None, True),
            (">1.0.dev0", "1.0.post0", None, None, True),
            # >V.preN: post-releases of the base release are NOT
            # post-releases of V.preN, so they are accepted
            (">1.0a1", "1.0.post0", None, None, True),
            (">1.0b1", "1.0.post0", None, None, True),
            (">1.0rc1", "1.0.post0", None, None, True),
            # >V.preN: post-releases of the pre-release itself
            # ARE excluded
            (">1.0a1", "1.0a1.post0", None, None, False),
            (">1.0b2", "1.0b2.post0", None, None, False),
            (">1.0rc1", "1.0rc1.post0", None, None, False),
            # >V.preN: post of a different pre is not a post-release
            # of V.preN either
            (">1.0a1", "1.0a2.post0", None, None, True),
            (">1.0b1", "1.0b2.post0", None, None, True),
            # >V.devN: non-post-release versions above V.devN
            (">1.0.dev1", "1.0", None, None, True),
            (">1.0.dev1", "1.0a1", None, None, True),
            (">1.0.dev1", "1.1", None, None, True),
            # >V (final): post-releases of V are still excluded
            (">1.0", "1.0.post0", None, None, False),
            (">1.0", "1.0.post1", None, None, False),
            # >V (final): post-releases of a different base are fine
            (">1.0", "2.0.post0", None, None, True),
            (">1.0", "0.9.post0", None, None, False),
            # >V.devN: locals and different bases
            (">1.0.dev1", "1.1.post0", None, None, True),
            (">1.0.dev1", "0.9.post0", None, None, False),
            # <V.postN: pre-releases of V.postN itself are excluded
            ("<1.0.post1", "1.0.post1.dev0", None, None, False),
            ("<1.0.post0", "1.0.post0.dev0", None, None, False),
            # <V.postN: pre-releases of the base release are NOT
            # pre-releases of V.postN, so they are accepted
            ("<1.0.post1", "1.0.dev0", None, None, True),
            ("<1.0.post1", "1.0a1", None, None, True),
            ("<1.0.post1", "1.0rc1", None, None, True),
            ("<1.0.post0", "1.0.dev0", None, None, True),
            ("<1.0.post0", "1.0a1", None, None, True),
            ("<1.0.post0", "1.0b1", None, None, True),
            ("<1.0.post0", "1.0rc2", None, None, True),
            # <V.postN: dev of a different post is not a pre-release
            # of V.postN either
            ("<1.0.post1", "1.0.post0.dev0", None, None, True),
            ("<1.0.post2", "1.0.post1.dev0", None, None, True),
            # <V.postN: non-pre-release versions below V.postN
            ("<1.0.post1", "1.0", None, None, True),
            ("<1.0.post1", "1.0.post0", None, None, True),
            ("<1.0.post1", "0.9", None, None, True),
            ("<1.0.post0", "1.0", None, None, True),
            # <V.postN: higher post numbers
            ("<1.0.post10", "1.0.dev0", None, None, True),
            ("<1.0.post10", "1.0.post9.dev0", None, None, True),
            ("<1.0.post10", "1.0.post9", None, None, True),
            # <V.postN: locals and different bases
            ("<1.0.post1", "1.0+local", None, None, True),
            ("<1.0.post1", "1.0.post0+local", None, None, True),
            ("<1.0.post1", "0.9.dev0", None, None, True),
            ("<=2.0", "1.0.dev1", False, None, False),
            ("<=2.0a1", "1.0.dev1", False, None, False),
            ("<=2.0", "1.0.dev1", None, False, False),
            ("<=2.0a1", "1.0.dev1", None, False, False),
            ("<=2.0", "1.0.dev1", True, False, False),
            ("<=2.0a1", "1.0.dev1", True, False, False),
            ("<=2.0", "1.0.dev1", False, True, True),
            ("<=2.0a1", "1.0.dev1", False, True, True),
        ],
    )
    def test_specifiers_prereleases(
        self,
        specifier: str,
        version: str,
        spec_pre: bool | None,
        contains_pre: bool | None,
        expected: bool,
    ) -> None:
        spec = Specifier(specifier, prereleases=spec_pre)

        assert spec.contains(version, prereleases=contains_pre) == expected

    @pytest.mark.parametrize(
        ("specifier", "specifier_prereleases", "prereleases", "input", "expected"),
        [
            # General test of the filter method
            (">=1.0.dev1", None, None, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            (">=1.2.3", None, None, ["1.2", "1.5a1"], ["1.5a1"]),
            (">=1.2.3", None, None, ["1.3", "1.5a1"], ["1.3"]),
            (">=1.0", None, None, ["2.0a1"], ["2.0a1"]),
            ("!=2.0a1", None, None, ["1.0a2", "1.0", "2.0a1"], ["1.0"]),
            ("==2.0a1", None, None, ["2.0a1"], ["2.0a1"]),
            (">2.0a1", None, None, ["2.0a1", "3.0a2", "3.0"], ["3.0a2", "3.0"]),
            ("<2.0a1", None, None, ["1.0a2", "1.0", "2.0a1"], ["1.0a2", "1.0"]),
            ("~=2.0a1", None, None, ["1.0", "2.0a1", "3.0a2", "3.0"], ["2.0a1"]),
            # Test overriding with the prereleases parameter on filter
            (">=1.0.dev1", None, False, ["1.0", "2.0a1"], ["1.0"]),
            # Test overriding with the overall specifier
            (">=1.0.dev1", True, None, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            (">=1.0.dev1", False, None, ["1.0", "2.0a1"], ["1.0"]),
            # Test when both specifier and filter have prerelease value
            (">=1.0", True, False, ["1.0", "2.0a1"], ["1.0"]),
            (">=1.0", False, True, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            (">=1.0", True, True, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            (">=1.0", False, False, ["1.0", "2.0a1"], ["1.0"]),
            # Test that invalid versions are discarded
            (">=1.0", None, None, ["not a valid version"], []),
            (">=1.0", None, None, ["1.0", "not a valid version"], ["1.0"]),
            # Test arbitrary equality (===)
            ("===foobar", None, None, ["foobar", "foo", "bar"], ["foobar"]),
            ("===foobar", None, None, ["foo", "bar"], []),
            # Test that === does not match with zero padding
            ("===1.0", None, None, ["1.0", "1.0.0", "2.0"], ["1.0"]),
            # Test that === does not match with local versions
            ("===1.0", None, None, ["1.0", "1.0+downstream1"], ["1.0"]),
            # Test === with mix of valid versions and arbitrary strings
            (
                "===foobar",
                None,
                None,
                ["foobar", "1.0", "2.0a1", "invalid"],
                ["foobar"],
            ),
            ("===1.0", None, None, ["1.0", "foobar", "invalid", "1.0.0"], ["1.0"]),
            # Test != with invalid versions (should not pass as versions are not valid)
            ("!=1.0", None, None, ["invalid", "foobar"], []),
            ("!=1.0", None, None, ["1.0", "invalid", "2.0"], ["2.0"]),
            ("!=2.0.*", None, None, ["invalid", "foobar", "2.0"], []),
            ("!=2.0.*", None, None, ["1.0", "invalid", "2.0.0"], ["1.0"]),
            # Test that !== ignores prereleases parameter for non-PEP 440 versions
            ("!=1.0", None, True, ["invalid", "foobar"], []),
            ("!=1.0", None, False, ["invalid", "foobar"], []),
            ("!=1.0", True, None, ["invalid", "foobar"], []),
            ("!=1.0", False, None, ["invalid", "foobar"], []),
            ("!=1.0", True, True, ["invalid", "foobar"], []),
            ("!=1.0", False, False, ["invalid", "foobar"], []),
            # Test that === ignores prereleases parameter for non-PEP 440 versions
            ("===foobar", None, True, ["foobar", "foo"], ["foobar"]),
            ("===foobar", None, False, ["foobar", "foo"], ["foobar"]),
            ("===foobar", True, None, ["foobar", "foo"], ["foobar"]),
            ("===foobar", False, None, ["foobar", "foo"], ["foobar"]),
            ("===foobar", True, True, ["foobar", "foo"], ["foobar"]),
            ("===foobar", False, False, ["foobar", "foo"], ["foobar"]),
        ],
    )
    def test_specifier_filter(
        self,
        specifier: str,
        specifier_prereleases: bool | None,
        prereleases: bool | None,
        input: list[str],
        expected: list[str],
    ) -> None:
        if specifier_prereleases is None:
            spec = Specifier(specifier)
            version_range = SpecifierSet(specifier).to_range()
        else:
            spec = Specifier(specifier, prereleases=specifier_prereleases)
            version_range = SpecifierSet(
                specifier, prereleases=specifier_prereleases
            ).to_range()

        if prereleases is None:
            result = list(spec.filter(input))
            range_result = list(version_range.filter(input))
        else:
            result = list(spec.filter(input, prereleases=prereleases))
            range_result = list(version_range.filter(input, prereleases=prereleases))

        assert result == expected
        # The range conversion must filter identically.
        assert range_result == expected

    @pytest.mark.parametrize(
        ("specifier", "input", "expected"),
        [
            # Strings preserve original form
            ("===1.01", ["1.01", "1.1", "1.0.1"], ["1.01"]),
            ("===1.1", ["1.01", "1.1"], ["1.1"]),
            # Version objects use normalized form
            (
                "===1.1",
                [Version("1.01"), Version("1.1")],
                [Version("1.01"), Version("1.1")],
            ),
            ("===1.01", [Version("1.01"), Version("1.1")], []),
            # Mixed strings and Version objects
            ("===1.1", ["1.01", "1.1", Version("1.01")], ["1.1", Version("1.01")]),
            ("===1.01", ["1.01", "1.1", Version("1.01")], ["1.01"]),
            # Prerelease separator
            ("===1.a1", ["1.a1", "1a1"], ["1.a1"]),
            ("===1a1", ["1.a1", "1a1", Version("1.a1")], ["1a1", Version("1.a1")]),
        ],
    )
    def test_specifier_filter_arbitrary_equality_normalization(
        self, specifier: str, input: list[str | Version], expected: list[str | Version]
    ) -> None:
        spec = Specifier(specifier, prereleases=True)
        assert list(spec.filter(input)) == expected

    @pytest.mark.parametrize(
        ("prereleases", "expected_indexes"),
        [
            (None, [1]),
            (True, [1]),
            (False, []),
        ],
    )
    def test_specifier_filter_with_key(
        self, prereleases: bool | None, expected_indexes: list[int]
    ) -> None:
        items = [
            {"version": "1.0"},
            {"version": "2.1a1"},
        ]
        spec = Specifier(">=2.0")
        if prereleases is None:
            result = list(spec.filter(items, key=lambda item: item["version"]))
        else:
            result = list(
                spec.filter(
                    items, key=lambda item: item["version"], prereleases=prereleases
                )
            )

        expected = [items[index] for index in expected_indexes]
        assert result == expected

    @pytest.mark.parametrize(
        ("spec", "op"),
        [
            ("~=2.0", "~="),
            ("==2.1.*", "=="),
            ("==2.1.0.3", "=="),
            ("!=2.2.*", "!="),
            ("!=2.2.0.5", "!="),
            ("<=5", "<="),
            (">=7.9a1", ">="),
            ("<1.0.dev1", "<"),
            (">2.0.post1", ">"),
            # === is an escape hatch in PEP 440
            ("===lolwat", "==="),
        ],
    )
    def test_specifier_operator_property(self, spec: str, op: str) -> None:
        assert Specifier(spec).operator == op

    @pytest.mark.parametrize(
        ("spec", "version"),
        [
            ("~=2.0", "2.0"),
            ("==2.1.*", "2.1.*"),
            ("==2.1.0.3", "2.1.0.3"),
            ("!=2.2.*", "2.2.*"),
            ("!=2.2.0.5", "2.2.0.5"),
            ("<=5", "5"),
            (">=7.9a1", "7.9a1"),
            ("<1.0.dev1", "1.0.dev1"),
            (">2.0.post1", "2.0.post1"),
            # === is an escape hatch in PEP 440
            ("===lolwat", "lolwat"),
        ],
    )
    def test_specifier_version_property(self, spec: str, version: str) -> None:
        assert Specifier(spec).version == version

    @pytest.mark.parametrize(
        ("spec_str", "expected_length"),
        [("", 0), ("==2.0", 1), (">=2.0", 1), (">=2.0,<3", 2), (">=2.0,<3,==2.4", 3)],
    )
    def test_length(self, spec_str: str, expected_length: int) -> None:
        spec = SpecifierSet(spec_str)
        assert len(spec) == expected_length

    @pytest.mark.parametrize(
        ("spec_str", "expected_items"),
        [
            ("", []),
            ("==2.0", ["==2.0"]),
            (">=2.0", [">=2.0"]),
            (">=2.0,<3", [">=2.0", "<3"]),
            (">=2.0,<3,==2.4", [">=2.0", "<3", "==2.4"]),
        ],
    )
    def test_iteration(self, spec_str: str, expected_items: list[str]) -> None:
        spec = SpecifierSet(spec_str)
        items = {str(item) for item in spec}
        assert items == set(expected_items)

    def test_specifier_equal_for_compatible_operator(self) -> None:
        assert Specifier("~=1.18.0") != Specifier("~=1.18")

    def test_specifier_hash_for_compatible_operator(self) -> None:
        assert hash(Specifier("~=1.18.0")) != hash(Specifier("~=1.18"))


class TestSpecifierInternal:
    """Tests for internal Specifier._spec_version cache behavior.

    Specifier._spec_version is a one-element cache that stores the parsed Version
    corresponding to Specifier.version after the first time it is needed for
    comparison, these tests validate that the cache is set and never changed.
    """

    @pytest.mark.parametrize(
        ("specifier", "test_versions"),
        [
            (">=1.0", ["0.9", "1.0", "1.1", "2.0"]),
            ("<=1.0", ["0.9", "1.0", "1.1", "2.0"]),
            (">1.0", ["0.9", "1.0", "1.1", "2.0"]),
            ("<1.0", ["0.9", "1.0", "1.1", "2.0"]),
            ("==1.0", ["0.9", "1.0", "1.1", "2.0"]),
            ("!=1.0", ["0.9", "1.0", "1.1", "2.0"]),
            ("~=1.0", ["0.9", "1.0", "1.1", "2.0"]),
            (">=1.0a1", ["0.9", "1.0a1", "1.0", "1.1"]),
            (">=1.0.post1", ["0.9", "1.0", "1.0.post1", "1.1"]),
            (">=1.0.dev1", ["0.9", "1.0.dev1", "1.0", "1.1"]),
            ("==1.0+local", ["1.0", "1.0+local", "1.0+other", "1.1"]),
            (">=1!1.0", ["0!2.0", "1!0.9", "1!1.0", "1!1.1"]),
        ],
    )
    def test_spec_version_cache_consistency(
        self, specifier: str, test_versions: list[str]
    ) -> None:
        """Cache is set on first contains and remains unchanged."""
        spec = Specifier(specifier, prereleases=True)
        assert spec._spec_version is None

        _ = test_versions[0] in spec
        assert spec._spec_version == (spec.version, Version(spec.version))
        initial_cache = spec._spec_version

        for v in test_versions[1:]:
            _ = v in spec
            assert spec._spec_version is initial_cache

        _ = hash(spec)
        assert spec._spec_version is initial_cache

        _ = spec.prereleases
        assert spec._spec_version is initial_cache

        _ = spec == Specifier(specifier)
        assert spec._spec_version is initial_cache

    @pytest.mark.parametrize(
        ("specifier", "test_versions"),
        [
            (
                "==1.0.*",
                ["0.9", "1.0", "1.0.1", "1.0a1", "1.0.dev1", "1.0.post1", "1.0+local"],
            ),
            (
                "!=1.0.*",
                ["0.9", "1.0", "1.0.1", "1.0a1", "1.0.dev1", "1.0.post1", "1.0+local"],
            ),
        ],
    )
    def test_spec_version_cache_with_wildcards(
        self, specifier: str, test_versions: list[str]
    ) -> None:
        """Wildcard specifiers cache the parsed base version once."""
        spec = Specifier(specifier, prereleases=True)

        for v in test_versions:
            _ = v in spec
        _ = spec.prereleases
        _ = hash(spec)

        # ``==1.0.*`` parses ``1.0`` for the range bounds; that
        # parsed base lands in the cache.
        assert spec._spec_version is not None
        assert spec._spec_version[0] == "1.0"

    @pytest.mark.parametrize(
        "specifier",
        [
            "===1.0",
            "===1.0.0+local",
            "===1.0.dev1",
        ],
    )
    def test_spec_version_cache_with_arbitrary_equality(self, specifier: str) -> None:
        spec = Specifier(specifier)

        _ = "1.0" in spec
        _ = spec.prereleases
        _ = hash(spec)

        assert spec._spec_version == (spec.version, Version(spec.version))

    @pytest.mark.parametrize(
        ("specifier", "versions"),
        [
            (
                "~=1.4.2",
                [
                    # Matching versions
                    "1.4.2",
                    "1.4.3.dev1",
                    "1.4.3a1",
                    "1.4.3",
                    "1.4.3.post1",
                    "1.4.3+local",
                    # Not matching versions
                    "1.4.1",
                    "1.4.1.post1",
                    "1.5.0.dev0",
                    "1.5.0a1",
                    "1.5.0",
                    "2.0",
                    "2.0+local",
                ],
            ),
        ],
    )
    def test_spec_version_cache_compatible_operator(
        self,
        specifier: str,
        versions: list[str],
    ) -> None:
        """~= caches the original spec version, not the prefix used for ==."""
        spec = Specifier(specifier, prereleases=True)
        assert spec._spec_version is None

        assert versions[0] in spec
        assert spec._spec_version == (spec.version, Version(spec.version))
        initial_cache = spec._spec_version

        for v in versions[1:]:
            _ = v in spec
            assert spec._spec_version is initial_cache

        _ = hash(spec)
        assert spec._spec_version is initial_cache

        _ = spec.prereleases
        assert spec._spec_version is initial_cache


class TestSpecifierSet:
    @pytest.mark.parametrize("version", VERSIONS)
    def test_empty_specifier(self, version: str) -> None:
        spec = SpecifierSet(prereleases=True)

        assert version in spec
        assert spec.contains(version)
        assert parse(version) in spec
        assert spec.contains(parse(version))

    @pytest.mark.parametrize(
        ("prereleases", "versions", "expected"),
        [
            # single arbitrary string
            (None, ["foobar"], ["foobar"]),
            (False, ["foobar"], ["foobar"]),
            (True, ["foobar"], ["foobar"]),
            # arbitrary string with a stable version present
            (None, ["foobar", "1.0"], ["foobar", "1.0"]),
            (False, ["foobar", "1.0"], ["foobar", "1.0"]),
            (True, ["foobar", "1.0"], ["foobar", "1.0"]),
            # arbitrary string with a prerelease only
            (None, ["foobar", "1.0a1"], ["foobar", "1.0a1"]),
            (False, ["foobar", "1.0a1"], ["foobar"]),
            (True, ["foobar", "1.0a1"], ["foobar", "1.0a1"]),
        ],
    )
    def test_empty_specifier_arbitrary_string(
        self, prereleases: bool | None, versions: list[str], expected: list[str]
    ) -> None:
        """Test empty SpecifierSet accepts arbitrary strings."""

        spec = SpecifierSet("", prereleases=prereleases)

        # basic behavior preserved
        assert spec.contains("foobar")

        # check filter behavior (no override of prereleases passed to filter)
        assert list(spec.filter(versions)) == expected

    @pytest.mark.parametrize(
        ("versions", "expected"),
        [
            # Mixed prerelease, arbitrary, final - return arbitrary and final in order
            (
                ["1.0a1", "foobar", "1.0", "2.0a1", "bazqux", "2.0"],
                ["foobar", "1.0", "bazqux", "2.0"],
            ),
            # Mixed arbitrary, final - return all in order
            (
                ["foobar", "1.0", "bazqux", "2.0", "hello"],
                ["foobar", "1.0", "bazqux", "2.0", "hello"],
            ),
            # Mixed prerelease, arbitrary (no final) - return all in order
            (
                ["1.0a1", "foobar", "2.0a1", "bazqux", "3.0a1"],
                ["1.0a1", "foobar", "2.0a1", "bazqux", "3.0a1"],
            ),
        ],
    )
    def test_empty_specifier_ordering_with_arbitrary(
        self, versions: list[str], expected: list[str]
    ) -> None:
        spec = SpecifierSet("")
        result = list(spec.filter(versions))
        assert result == expected

    def test_create_from_specifiers(self) -> None:
        spec_strs = [">=1.0", "!=1.1", "!=1.2", "<2.0"]
        specs = [Specifier(s) for s in spec_strs]
        spec = SpecifierSet(iter(specs))
        assert set(spec) == set(specs)

    def test_match_args(self) -> None:
        assert SpecifierSet.__match_args__ == ("_str",)
        assert SpecifierSet(">=1.0,<2")._str == str(SpecifierSet(">=1.0,<2"))

    @pytest.mark.parametrize(
        (
            "initial_prereleases",
            "set_prereleases",
            "version",
            "initial_contains",
            "final_contains",
            "spec_str",
        ),
        [
            (None, True, "1.0.dev1", True, True, ""),
            (False, True, "1.0.dev1", False, True, ""),
            # Setting prerelease from True to False
            (True, False, "1.0.dev1", True, False, ""),
            (True, False, "1.0.dev1", False, False, ">=1.0"),
            (True, False, "1.0.dev1", True, False, "==1.*"),
            # Setting prerelease from False to None
            (False, None, "1.0.dev1", False, True, ""),
            (False, None, "2.0.dev1", False, True, ">=1.0"),
            # Setting prerelease from True to None
            (True, None, "1.0.dev1", True, True, ""),
            (True, None, "2.0.dev1", True, True, ">=1.0"),
            # Various version patterns with different transitions
            (None, True, "2.0b1", True, True, ""),
            (None, False, "2.0a1", True, False, ""),
            (True, False, "1.0rc1", True, False, ""),
            (False, True, "1.0.post1.dev1", False, True, ""),
            # Specifiers that include prerelease versions explicitly
            (None, False, "2.0.dev1", True, False, "==2.0.dev1"),
            (True, False, "1.0.dev1", True, False, "==1.0.*"),
            (False, True, "1.0.dev1", False, True, "!=2.0"),
            # SpecifierSet with multiple specifiers
            (None, True, "1.5a1", True, True, ">=1.0,<2.0"),
            (False, True, "1.5b1", False, True, ">=1.0,<2.0"),
            (True, False, "1.5rc1", True, False, ">=1.0,<2.0"),
            # Test with dev/alpha/beta/rc variations
            (None, True, "1.0a1", True, True, ""),
            (None, True, "1.0b2", True, True, ""),
            (None, True, "1.0rc3", True, True, ""),
            (None, True, "1.0.dev4", True, True, ""),
            # Test with specifiers that have prereleases implicitly
            (None, False, "1.0a1", True, False, ">=1.0a1"),
            (None, False, "0.9.dev0", True, False, "<1.0.dev1"),
        ],
    )
    def test_specifier_prereleases_explicit(
        self,
        initial_prereleases: bool | None,
        set_prereleases: bool | None,
        version: str,
        initial_contains: bool,
        final_contains: bool,
        spec_str: str,
    ) -> None:
        """Test setting prereleases property with different initial states."""
        spec = SpecifierSet(spec_str, prereleases=initial_prereleases)

        assert (version in spec) == initial_contains
        assert spec.contains(version) == initial_contains

        spec.prereleases = set_prereleases

        assert (version in spec) == final_contains
        assert spec.contains(version) == final_contains

    def test_specifier_contains_prereleases(self) -> None:
        spec = SpecifierSet()
        assert spec.prereleases is None
        assert spec.contains("1.0.dev1")
        assert spec.contains("1.0.dev1", prereleases=True)

        spec = SpecifierSet(prereleases=True)
        assert spec.prereleases
        assert spec.contains("1.0.dev1")
        assert not spec.contains("1.0.dev1", prereleases=False)

    @pytest.mark.parametrize(
        (
            "specifier",
            "version",
            "spec_prereleases",
            "contains_prereleases",
            "installed",
            "expected",
        ),
        [
            ("~=1.0", "1.1.0.dev1", None, None, True, True),
            ("~=1.0", "1.1.0.dev1", False, False, True, True),
            ("~=1.0", "1.1.0.dev1", True, False, True, True),
            ("~=1.0", "1.1.0.dev1", None, False, True, True),
            # Case when installed=False:
            ("~=1.0", "1.1.0.dev1", None, True, False, True),
            ("~=1.0", "1.1.0.dev1", False, True, False, True),
            ("~=1.0", "1.1.0.dev1", False, False, False, False),
            ("~=1.0", "1.1.0.dev1", None, False, False, False),
            # Test with different version types
            ("~=1.0", "1.1.0a1", None, None, True, True),
            ("~=1.0", "1.1.0b1", None, None, True, True),
            ("~=1.0", "1.1.0rc1", None, None, True, True),
            ("~=1.0", "1.1.0.post1.dev1", None, None, True, True),
            # Test with different specifiers
            (">=1.0", "2.0.dev1", None, None, True, True),
            ("==1.*", "1.5.0a1", None, None, True, True),
            (">=1.0,<3.0", "2.0.dev1", None, None, True, True),
            ("!=2.0", "2.0.dev1", None, None, True, True),
            # Test with non-matching versions (regardless of installed)
            ("~=1.0", "3.0.0.dev1", None, None, True, False),
            ("~=1.0", "3.0.0.dev1", True, None, True, False),
            ("~=1.0", "3.0.0.dev1", None, True, True, False),
            ("~=1.0", "3.0.0.dev1", True, True, True, False),
            ("~=1.0", "3.0.0.dev1", False, False, True, False),
            ("~=1.0", "3.0.0.dev1", None, None, False, False),
            # Test with versions outside specifier but with prereleases
            (">=2.0", "1.9.0.dev1", True, None, True, False),
            (">=2.0", "1.9.0.dev1", None, True, True, False),
            (">=2.0", "1.9.0.dev1", True, True, True, False),
            (">=2.0", "1.9.0.dev1", None, None, False, False),
            # Test with edge versions
            (">=1.0", "1.0.0.dev1", None, None, True, False),
            ("<=1.0", "1.0.0.dev1", None, None, True, True),
            ("<1.0", "1.0.0.dev1", None, None, True, False),
            ("<1.0", "0.9.0.dev1", None, None, True, True),
            # Test with specifiers that have explicit prereleases
            (">=1.0.dev1", "1.0.0.dev1", None, None, True, True),
            (">=1.0.dev1", "1.0.0.dev1", False, False, False, False),
            ("==1.0.0.dev1", "1.0.0.dev1", False, False, False, False),
            # Test with stable versions
            ("~=1.0", "1.1.0", None, None, True, True),
            ("~=1.0", "1.1.0", False, False, False, True),
            ("~=1.0", "1.1.0", True, False, False, True),
            # Test combinations of prereleases=True/False and installed=True/False
            ("~=1.0", "1.1.0.dev1", True, None, False, True),
            ("~=1.0", "1.1.0.dev1", False, None, False, False),
            # Test conflicting prereleases and contain_prereleases
            ("~=1.0", "1.1.0.dev1", True, False, False, False),
            # Test with specifiers that explicitly have prereleases overridden
            (">=1.0.dev1", "1.0.0.dev1", None, False, False, False),
            (">=1.0.dev1", "1.0.0.dev1", False, None, False, False),
        ],
    )
    def test_specifier_contains_installed_prereleases(
        self,
        specifier: str,
        version: str,
        spec_prereleases: bool | None,
        contains_prereleases: bool | None,
        installed: bool | None,
        expected: bool,
    ) -> None:
        """Test the behavior of SpecifierSet.contains with installed and prereleases."""
        spec = SpecifierSet(specifier, prereleases=spec_prereleases)

        kwargs = {}
        if contains_prereleases is not None:
            kwargs["prereleases"] = contains_prereleases
        if installed is not None:
            kwargs["installed"] = installed

        assert spec.contains(version, **kwargs) == expected

        spec = SpecifierSet("~=1.0", prereleases=False)
        assert spec.contains("1.1.0.dev1", installed=True)
        assert not spec.contains("1.1.0.dev1", prereleases=False, installed=False)

    @pytest.mark.parametrize(
        ("specifier", "specifier_prereleases", "prereleases", "input", "expected"),
        [
            # General test of the filter method
            ("", None, None, ["1.0", "2.0a1"], ["1.0"]),
            (">=1.0.dev1", None, None, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            ("", None, None, ["1.0a1"], ["1.0a1"]),
            (">=1.2.3", None, None, ["1.2", "1.5a1"], ["1.5a1"]),
            (">=1.2.3", None, None, ["1.3", "1.5a1"], ["1.3"]),
            ("", None, None, ["1.0", Version("2.0")], ["1.0", Version("2.0")]),
            (">=1.0", None, None, ["2.0a1"], ["2.0a1"]),
            ("!=2.0a1", None, None, ["1.0a2", "1.0", "2.0a1"], ["1.0"]),
            ("==2.0a1", None, None, ["2.0a1"], ["2.0a1"]),
            (">2.0a1", None, None, ["2.0a1", "3.0a2", "3.0"], ["3.0a2", "3.0"]),
            ("<2.0a1", None, None, ["1.0a2", "1.0", "2.0a1"], ["1.0a2", "1.0"]),
            ("~=2.0a1", None, None, ["1.0", "2.0a1", "3.0a2", "3.0"], ["2.0a1"]),
            # Test overriding with the prereleases parameter on filter
            ("", None, False, ["1.0a1"], []),
            (">=1.0.dev1", None, False, ["1.0", "2.0a1"], ["1.0"]),
            ("", None, True, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            # Test overriding with the overall specifier
            ("", True, None, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            ("", False, None, ["1.0", "2.0a1"], ["1.0"]),
            (">=1.0.dev1", True, None, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            (">=1.0.dev1", False, None, ["1.0", "2.0a1"], ["1.0"]),
            ("", True, None, ["1.0a1"], ["1.0a1"]),
            ("", False, None, ["1.0a1"], []),
            # Test when both specifier and filter have prerelease value
            (">=1.0", True, False, ["1.0", "2.0a1"], ["1.0"]),
            (">=1.0", False, True, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            (">=1.0", True, True, ["1.0", "2.0a1"], ["1.0", "2.0a1"]),
            (">=1.0", False, False, ["1.0", "2.0a1"], ["1.0"]),
            # Test when there are multiple specifiers
            (">=1.0,<=2.0", None, None, ["1.0", "1.5a1"], ["1.0"]),
            (">=1.0,<=2.0dev", None, None, ["1.0", "1.5a1"], ["1.0", "1.5a1"]),
            (">=1.0,<=2.0", True, None, ["1.0", "1.5a1"], ["1.0", "1.5a1"]),
            (">=1.0,<=2.0", False, None, ["1.0", "1.5a1"], ["1.0"]),
            (">=1.0,<=2.0dev", False, None, ["1.0", "1.5a1"], ["1.0"]),
            (">=1.0,<=2.0dev", True, None, ["1.0", "1.5a1"], ["1.0", "1.5a1"]),
            (">=1.0,<=2.0", None, False, ["1.0", "1.5a1"], ["1.0"]),
            (">=1.0,<=2.0", None, True, ["1.0", "1.5a1"], ["1.0", "1.5a1"]),
            (">=1.0,<=2.0dev", None, False, ["1.0", "1.5a1"], ["1.0"]),
            (">=1.0,<=2.0dev", None, True, ["1.0", "1.5a1"], ["1.0", "1.5a1"]),
            (">=1.0,<=2.0", True, False, ["1.0", "1.5a1"], ["1.0"]),
            (">=1.0,<=2.0", False, True, ["1.0", "1.5a1"], ["1.0", "1.5a1"]),
            (">=1.0,<=2.0dev", True, False, ["1.0", "1.5a1"], ["1.0"]),
            (">=1.0,<=2.0dev", False, True, ["1.0", "1.5a1"], ["1.0", "1.5a1"]),
            # Test that invalid versions are accepted by empty SpecifierSet
            ("", None, None, ["invalid version"], ["invalid version"]),
            ("", None, False, ["invalid version"], ["invalid version"]),
            ("", False, None, ["invalid version"], ["invalid version"]),
            ("", None, None, ["1.0", "invalid version"], ["1.0", "invalid version"]),
            ("", None, False, ["1.0", "invalid version"], ["1.0", "invalid version"]),
            ("", False, None, ["1.0", "invalid version"], ["1.0", "invalid version"]),
            # Test arbitrary equality (===)
            ("===foobar", None, None, ["foobar", "foo", "bar"], ["foobar"]),
            ("===foobar", None, None, ["foo", "bar"], []),
            # Test that === does not match with zero padding
            ("===1.0", None, None, ["1.0", "1.0.0", "2.0"], ["1.0"]),
            # Test that === does not match with local versions
            ("===1.0", None, None, ["1.0", "1.0+downstream1"], ["1.0"]),
            # Test === combined with other operators (arbitrary string)
            (">=1.0,===foobar", None, None, ["foobar", "1.0", "2.0"], []),
            ("!=2.0,===foobar", None, None, ["foobar", "2.0", "bar"], []),
            # Test === combined with other operators (version string)
            (">=1.0,===1.5", None, None, ["1.0", "1.5", "2.0"], ["1.5"]),
            (">=2.0,===1.5", None, None, ["1.0", "1.5", "2.0"], []),
            # Test === with mix of valid and invalid versions
            (
                "===foobar",
                None,
                None,
                ["foobar", "1.0", "invalid", "2.0a1"],
                ["foobar"],
            ),
            ("===1.0", None, None, ["1.0", "foobar", "invalid", "1.0.0"], ["1.0"]),
            (">=1.0,===1.5", None, None, ["1.5", "foobar", "invalid"], ["1.5"]),
            # Test != with invalid versions (should pass through as "not equal")
            ("!=1.0", None, None, ["invalid", "foobar"], []),
            ("!=1.0", None, None, ["1.0", "invalid", "2.0"], ["2.0"]),
            (
                "!=2.0.*",
                None,
                None,
                ["invalid", "foobar", "2.0"],
                [],
            ),
            ("!=2.0.*", None, None, ["1.0", "invalid", "2.0.0"], ["1.0"]),
            # Test != with invalid versions combined with other operators
            (
                "!=1.0,!=2.0",
                None,
                None,
                ["invalid", "1.0", "2.0", "3.0"],
                ["3.0"],
            ),
            (
                ">=1.0,!=2.0",
                None,
                None,
                ["invalid", "1.0", "2.0", "3.0"],
                ["1.0", "3.0"],
            ),
            # Test that === ignores prereleases parameter for non-PEP 440 versions
            ("===foobar", None, True, ["foobar", "foo"], ["foobar"]),
            ("===foobar", None, False, ["foobar", "foo"], ["foobar"]),
            ("===foobar", True, None, ["foobar", "foo"], ["foobar"]),
            ("===foobar", False, None, ["foobar", "foo"], ["foobar"]),
            ("===foobar", True, True, ["foobar", "foo"], ["foobar"]),
            ("===foobar", False, False, ["foobar", "foo"], ["foobar"]),
            # Test === with multiple specifiers matching non-parseable versions
            (
                "===foobar,===foobar",
                None,
                None,
                ["foobar", "foo", "bar"],
                ["foobar"],
            ),
            # Test ==.* in multi-specifier set
            ("==1.*,>=1.0", None, None, ["0.9", "1.0", "1.5", "2.0"], ["1.0", "1.5"]),
        ],
    )
    def test_specifier_filter(
        self,
        specifier: str,
        specifier_prereleases: bool | None,
        prereleases: bool | None,
        input: list[str],
        expected: list[str],
    ) -> None:
        if specifier_prereleases is None:
            spec = SpecifierSet(specifier)
        else:
            spec = SpecifierSet(specifier, prereleases=specifier_prereleases)
        version_range = spec.to_range()

        if prereleases is None:
            result = list(spec.filter(input))
            range_result = list(version_range.filter(input))
        else:
            result = list(spec.filter(input, prereleases=prereleases))
            range_result = list(version_range.filter(input, prereleases=prereleases))

        assert result == expected
        # The range conversion must filter identically.
        assert range_result == expected

    @pytest.mark.parametrize(
        ("prereleases", "expected_indexes"),
        [
            (None, [1]),
            (True, [1]),
            (False, []),
        ],
    )
    def test_specifierset_filter_with_key(
        self, prereleases: bool | None, expected_indexes: list[int]
    ) -> None:
        items = [
            {"version": "1.0"},
            {"version": "2.1a1"},
        ]
        spec = SpecifierSet(">=2")
        if prereleases is None:
            result = list(spec.filter(items, key=lambda item: item["version"]))
        else:
            result = list(
                spec.filter(
                    items, key=lambda item: item["version"], prereleases=prereleases
                )
            )

        expected = [items[index] for index in expected_indexes]
        assert result == expected

    @pytest.mark.parametrize(
        ("prereleases", "expected_indexes"),
        [
            (None, [1]),
            (True, [0, 1]),
            (False, [1]),
        ],
    )
    def test_empty_specifierset_filter_with_key(
        self, prereleases: bool | None, expected_indexes: list[int]
    ) -> None:
        items = [
            {"version": "2.0a1"},
            {"version": "2.1"},
        ]

        spec = SpecifierSet("", prereleases=prereleases)
        result = list(spec.filter(items, key=lambda item: item["version"]))

        expected = [items[index] for index in expected_indexes]
        assert result == expected

    @pytest.mark.parametrize(
        ("specifier", "prereleases", "input", "expected"),
        [
            # !=1.*, !=2.*, !=3.0 leaves gap at 3.0 prereleases
            (
                ">=1,!=1.*,!=2.*,!=3.0,<=3.0",
                None,
                ["3.0.dev0", "3.0a1"],
                ["3.0.dev0", "3.0a1"],
            ),
            (
                ">=1,!=1.*,!=2.*,!=3.0,<=3.0",
                None,
                ["0.9", "3.0.dev0", "3.0a1", "4.0"],
                ["3.0.dev0", "3.0a1"],
            ),
            (
                ">=1,!=1.*,!=2.*,!=3.0,<=3.0",
                True,
                ["0.9", "3.0.dev0", "3.0a1", "4.0"],
                ["3.0.dev0", "3.0a1"],
            ),
            (
                ">=1,!=1.*,!=2.*,!=3.0,<=3.0",
                False,
                ["0.9", "3.0.dev0", "3.0a1", "4.0"],
                [],
            ),
            # >=1.0a1,!=1.*,!=2.*,<3.0 has no matching versions
            # because <3.0 excludes 3.0 prereleases
            (
                ">=1.0a1,!=1.*,!=2.*,<3.0",
                None,
                ["1.0a1", "2.0a1", "3.0a1"],
                [],
            ),
            (
                ">=1.0a1,!=1.*,!=2.*,<3.0",
                True,
                ["1.0a1", "2.0a1", "3.0a1"],
                [],
            ),
            (
                ">=1.0a1,!=1.*,!=2.*,<3.0",
                False,
                ["1.0a1", "2.0a1", "3.0a1"],
                [],
            ),
            # >=1.0.dev0,!=1.*,!=2.*,<3.0.dev0 has no matching versions
            (
                ">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0",
                None,
                ["1.0.dev0", "2.0.dev0", "3.0.dev0"],
                [],
            ),
            (
                ">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0",
                True,
                ["1.0.dev0", "2.0.dev0", "3.0.dev0"],
                [],
            ),
            (
                ">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0",
                False,
                ["1.0.dev0", "2.0.dev0", "3.0.dev0"],
                [],
            ),
            # Gaps with post-releases
            (
                ">=1.0,!=1.0,!=1.1,<2.0",
                None,
                ["1.0.post1", "1.1.post1"],
                ["1.0.post1", "1.1.post1"],
            ),
            (
                ">=1.0,!=1.0,!=1.1,<2.0",
                None,
                ["0.9", "1.0.post1", "1.1.post1", "2.0"],
                ["1.0.post1", "1.1.post1"],
            ),
            (
                ">=1.0,!=1.0,!=1.1,<2.0",
                True,
                ["0.9", "1.0.post1", "1.1.post1", "2.0"],
                ["1.0.post1", "1.1.post1"],
            ),
            (
                ">=1.0,!=1.0,!=1.1,<2.0",
                False,
                ["0.9", "1.0.post1", "1.1.post1", "2.0"],
                ["1.0.post1", "1.1.post1"],
            ),
            # Dev version gaps
            (
                ">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4",
                None,
                ["3.0.dev0", "3.1.dev0"],
                ["3.0.dev0", "3.1.dev0"],
            ),
            (
                ">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4",
                None,
                ["0.5", "3.0.dev0", "3.1.dev0", "5.0"],
                ["3.0.dev0", "3.1.dev0"],
            ),
            (
                ">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4",
                True,
                ["0.5", "3.0.dev0", "3.1.dev0", "5.0"],
                ["3.0.dev0", "3.1.dev0"],
            ),
            (
                ">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4",
                False,
                ["0.5", "3.0.dev0", "3.1.dev0", "5.0"],
                [],
            ),
            # Test that < (exclusive) excludes prereleases of the specified version
            # but allows prereleases of earlier versions.
            # <1.1 excludes 1.1.dev0, 1.1a1, etc. but allows 1.0a1, 1.0b1
            (
                ">=1.0a1,!=1.0,<1.1",
                None,
                ["1.0a1", "1.0b1"],
                ["1.0a1", "1.0b1"],
            ),
            (
                ">=1.0a1,!=1.0,<1.1",
                None,
                ["0.9", "1.0a1", "1.0b1", "1.1"],
                ["1.0a1", "1.0b1"],
            ),
            (
                ">=1.0a1,!=1.0,<1.1",
                None,
                ["1.0a1", "1.0b1", "1.1.dev0", "1.1a1"],
                ["1.0a1", "1.0b1"],
            ),
            (
                ">=1.0a1,!=1.0,<1.1",
                True,
                ["0.9", "1.0a1", "1.0b1", "1.1"],
                ["1.0a1", "1.0b1"],
            ),
            (
                ">=1.0a1,!=1.0,<1.1",
                True,
                ["1.0a1", "1.0b1", "1.1.dev0", "1.1a1"],
                ["1.0a1", "1.0b1"],
            ),
            (
                ">=1.0a1,!=1.0,<1.1",
                False,
                ["0.9", "1.0a1", "1.0b1", "1.1"],
                [],
            ),
            # Test that <= (inclusive) allows prereleases of the specified version
            # when explicitly requested, but follows default prerelease filtering
            # when prereleases=None (excludes them if final releases present)
            (
                ">=0.9,!=0.9,<=1.0",
                None,
                ["0.9.post1", "1.0.dev0", "1.0a1", "1.0"],
                [
                    "0.9.post1",
                    "1.0",
                ],  # prereleases filtered out due to presence of final release
            ),
            (
                ">=0.9,!=0.9,<=1.0",
                None,
                ["0.9.post1", "1.0.dev0", "1.0a1", "1.0", "1.0.post1"],
                [
                    "0.9.post1",
                    "1.0",
                ],  # dev/alpha filtered out; post-releases not included with <=
            ),
            (
                ">=0.9,!=0.9,<=1.0",
                True,
                ["0.9.post1", "1.0.dev0", "1.0a1", "1.0", "1.1"],
                [
                    "0.9.post1",
                    "1.0.dev0",
                    "1.0a1",
                    "1.0",
                ],  # includes prereleases when explicitly True
            ),
            (
                ">=0.9,!=0.9,<=1.0",
                False,
                ["0.9.post1", "1.0.dev0", "1.0a1", "1.0", "1.1"],
                ["0.9.post1", "1.0"],
            ),
            # Epoch-based gaps
            (
                ">=1!0,!=1!1.*,!=1!2.*,<1!3",
                None,
                ["1!0.5", "1!2.5"],
                ["1!0.5"],
            ),
            (
                ">=1!0,!=1!1.*,!=1!2.*,<1!3",
                None,
                ["0!5.0", "1!0.5", "1!2.5", "2!0.0"],
                ["1!0.5"],
            ),
            (
                ">=1!0,!=1!1.*,!=1!2.*,<1!3",
                True,
                ["0!5.0", "1!0.5", "1!2.5", "2!0.0"],
                ["1!0.5"],
            ),
            (
                ">=1!0,!=1!1.*,!=1!2.*,<1!3",
                False,
                ["0!5.0", "1!0.5", "1!2.5", "2!0.0"],
                ["1!0.5"],
            ),
        ],
    )
    def test_filter_exclusionary_bridges(
        self,
        specifier: str,
        prereleases: bool | None,
        input: list[str],
        expected: list[str],
    ) -> None:
        """
        Test that filter correctly handles exclusionary bridges.

        When specifiers exclude certain version ranges (e.g., !=1.*, !=2.*),
        there may be "gaps" where only prerelease, dev, or post versions match.
        The filter should return these matching versions regardless of whether
        non-matching non-prerelease versions are present in the input.
        """
        spec = SpecifierSet(specifier)
        if prereleases is None:
            result = list(spec.filter(input))
        else:
            result = list(spec.filter(input, prereleases=prereleases))

        assert result == expected

    @pytest.mark.parametrize(
        ("specifier", "prereleases", "version", "expected"),
        [
            # !=1.*, !=2.*, !=3.0 leaves gap at 3.0 prereleases
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", None, "3.0.dev0", True),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", None, "3.0a1", True),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", True, "3.0.dev0", True),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", True, "3.0a1", True),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", False, "3.0.dev0", False),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", False, "3.0a1", False),
            # Versions outside the gap should not match
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", None, "0.9", False),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", None, "1.0", False),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", None, "2.0", False),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", None, "3.0", False),
            (">=1,!=1.*,!=2.*,!=3.0,<=3.0", None, "4.0", False),
            # >=1.0a1,!=1.*,!=2.*,<3.0 has no matching versions
            # because <3.0 excludes 3.0 prereleases
            (">=1.0a1,!=1.*,!=2.*,<3.0", None, "1.0a1", False),
            (">=1.0a1,!=1.*,!=2.*,<3.0", None, "2.0a1", False),
            (">=1.0a1,!=1.*,!=2.*,<3.0", None, "3.0a1", False),
            (">=1.0a1,!=1.*,!=2.*,<3.0", True, "1.0a1", False),
            (">=1.0a1,!=1.*,!=2.*,<3.0", True, "2.0a1", False),
            (">=1.0a1,!=1.*,!=2.*,<3.0", False, "1.0a1", False),
            (">=1.0a1,!=1.*,!=2.*,<3.0", False, "2.0a1", False),
            # >=1.0.dev0,!=1.*,!=2.*,<3.0.dev0 has no matching versions
            (">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0", None, "1.0.dev0", False),
            (">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0", None, "2.0.dev0", False),
            (">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0", None, "3.0.dev0", False),
            (">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0", True, "1.0.dev0", False),
            (">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0", True, "2.0.dev0", False),
            (">=1.0.dev0,!=1.*,!=2.*,<3.0.dev0", False, "1.0.dev0", False),
            # Gaps with post-releases
            (">=1.0,!=1.0,!=1.1,<2.0", None, "1.0.post1", True),
            (">=1.0,!=1.0,!=1.1,<2.0", None, "1.1.post1", True),
            (">=1.0,!=1.0,!=1.1,<2.0", None, "1.0", False),
            (">=1.0,!=1.0,!=1.1,<2.0", None, "1.1", False),
            (">=1.0,!=1.0,!=1.1,<2.0", None, "2.0", False),
            (">=1.0,!=1.0,!=1.1,<2.0", True, "1.0.post1", True),
            (">=1.0,!=1.0,!=1.1,<2.0", True, "1.1.post1", True),
            (">=1.0,!=1.0,!=1.1,<2.0", False, "1.0.post1", True),
            (">=1.0,!=1.0,!=1.1,<2.0", False, "1.1.post1", True),
            # Dev version gaps
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", None, "3.0.dev0", True),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", None, "3.1.dev0", True),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", None, "0.5", False),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", None, "3.0", False),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", None, "3.1", False),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", None, "5.0", False),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", True, "3.0.dev0", True),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", True, "3.1.dev0", True),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", False, "3.0.dev0", False),
            (">=1,!=1.*,!=2.*,!=3.0,!=3.1,<4", False, "3.1.dev0", False),
            # Test that < (exclusive) excludes prereleases of the specified version
            # but allows prereleases of earlier versions
            (">=1.0a1,!=1.0,<1.1", None, "1.0a1", True),
            (">=1.0a1,!=1.0,<1.1", None, "1.0b1", True),
            (">=1.0a1,!=1.0,<1.1", None, "0.9", False),
            (">=1.0a1,!=1.0,<1.1", None, "1.0", False),
            (">=1.0a1,!=1.0,<1.1", None, "1.1", False),
            (">=1.0a1,!=1.0,<1.1", None, "1.1.dev0", False),
            (">=1.0a1,!=1.0,<1.1", None, "1.1a1", False),
            (">=1.0a1,!=1.0,<1.1", True, "1.0a1", True),
            (">=1.0a1,!=1.0,<1.1", True, "1.0b1", True),
            (">=1.0a1,!=1.0,<1.1", True, "1.1.dev0", False),
            (">=1.0a1,!=1.0,<1.1", True, "1.1a1", False),
            (">=1.0a1,!=1.0,<1.1", False, "1.0a1", False),
            (">=1.0a1,!=1.0,<1.1", False, "1.0b1", False),
            # Test that <= (inclusive) allows prereleases of the specified version
            # when explicitly requested, but follows default prerelease filtering
            (">=0.9,!=0.9,<=1.0", None, "0.9.post1", True),
            (">=0.9,!=0.9,<=1.0", None, "1.0", True),
            (
                ">=0.9,!=0.9,<=1.0",
                None,
                "1.0.dev0",
                True,
            ),  # <= allows prereleases of specified version
            (
                ">=0.9,!=0.9,<=1.0",
                None,
                "1.0a1",
                True,
            ),  # <= allows prereleases of specified version
            (
                ">=0.9,!=0.9,<=1.0",
                None,
                "1.0.post1",
                False,
            ),  # 1.0.post1 > 1.0 so excluded by <=1.0
            (">=0.9,!=0.9,<=1.0", True, "0.9.post1", True),
            (">=0.9,!=0.9,<=1.0", True, "1.0.dev0", True),
            (">=0.9,!=0.9,<=1.0", True, "1.0a1", True),
            (">=0.9,!=0.9,<=1.0", True, "1.0", True),
            (">=0.9,!=0.9,<=1.0", False, "0.9.post1", True),
            (">=0.9,!=0.9,<=1.0", False, "1.0.dev0", False),
            (">=0.9,!=0.9,<=1.0", False, "1.0a1", False),
            (">=0.9,!=0.9,<=1.0", False, "1.0", True),
            # Epoch-based gaps
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", None, "1!0.5", True),
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", None, "1!2.5", False),
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", None, "0!5.0", False),
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", None, "2!0.0", False),
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", True, "1!0.5", True),
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", True, "0!5.0", False),
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", False, "1!0.5", True),
            (">=1!0,!=1!1.*,!=1!2.*,<1!3", False, "0!5.0", False),
            # >V.devN combined with other specifiers: post-releases of
            # the base release are accepted (they are not post-releases
            # of V.devN).
            (">1.0.dev1,==1.0.post0", None, "1.0.post0", True),
            (">1.0.dev1,==1.0.post1", None, "1.0.post1", True),
            (">1.0a1,==1.0.post0", None, "1.0.post0", True),
            (">1.0.dev1,<=2.0", None, "1.0.post0", True),
            (">1.0.dev1,<=2.0", None, "1.0", True),
            # >V.preN: post of the pre-release itself is still excluded
            (">1.0a1,<=2.0", True, "1.0a1.post0", False),
            # With an upper bound that includes post-releases
            (">1.0.dev1,<=1.0.post1", None, "1.0.post0", True),
            (">1.0.dev1,<=1.0.post1", None, "1.0.post1", True),
            (">1.0.dev1,<=1.0.post1", None, "1.0", True),
            # != can remove some versions but post-releases still match
            (">1.0.dev1,!=1.0,<=2.0", None, "1.0.post0", True),
            (">1.0.dev1,!=1.0,!=1.0.post0,<=2.0", None, "1.0.post1", True),
            # <V.postN combined with other specifiers: pre-releases of
            # the base release are accepted (they are not pre-releases
            # of V.postN).
            ("==1.0.dev0,<1.0.post1", None, "1.0.dev0", True),
            ("==1.0a1,<1.0.post0", None, "1.0a1", True),
            ("==1.0.post0.dev0,<1.0.post1", None, "1.0.post0.dev0", True),
            (">=1.0,<1.0.post1", None, "1.0", True),
            (">=1.0,<1.0.post1", None, "1.0.post0", True),
            # 1.0.dev0 < 1.0, so it fails >=1.0 regardless of <
            (">=1.0,<1.0.post1", True, "1.0.dev0", False),
            # With a lower bound that includes pre-releases
            (">=1.0.dev0,<1.0.post1", True, "1.0.dev0", True),
            (">=1.0.dev0,<1.0.post1", True, "1.0.a1", True),
            (">=1.0.dev0,<1.0.post1", True, "1.0.post0.dev0", True),
            # != can remove non-pre-releases but pre-releases still match
            (">=1.0.dev0,<1.0.post1,!=1.0,!=1.0.post0", True, "1.0.dev0", True),
            (">=1.0.dev0,<1.0.post1,!=1.0,!=1.0.post0", True, "1.0.post0.dev0", True),
            # Post-release survivors still match
            (">=1.0.dev0,<1.0.post2,!=1.0,!=1.0.post0", True, "1.0.post1", True),
            (">=1.0.dev0,<1.0.post2,!=1.0", True, "1.0.post0", True),
        ],
    )
    def test_contains_exclusionary_bridges(
        self, specifier: str, prereleases: bool | None, version: str, expected: bool
    ) -> None:
        """
        Test that contains correctly handles exclusionary bridges.

        When specifiers exclude certain version ranges (e.g., !=1.*, !=2.*),
        there may be "gaps" where only prerelease, dev, or post versions match.
        The contains method should return True for versions in these gaps
        when prereleases=None, following PEP 440 logic.
        """
        spec = SpecifierSet(specifier)
        kwargs = {"prereleases": prereleases} if prereleases is not None else {}
        assert spec.contains(version, **kwargs) == expected

    @pytest.mark.parametrize(
        ("specifier", "input"),
        [
            (">=1.0", "not a valid version"),
        ],
    )
    def test_contains_rejects_invalid_specifier(
        self, specifier: str, input: str
    ) -> None:
        spec = SpecifierSet(specifier, prereleases=True)
        assert not spec.contains(input)

    @pytest.mark.parametrize(
        ("spec_str", "version", "expected"),
        [
            # ">V" excludes every post-release of V (PEP 440 exclusive ordered
            # comparison); intersecting with "!=V.postN" must not re-admit a
            # different post-release of V.
            (">1.0,!=1.0.post1", "1.0.post2", False),
            (">1.0,!=1.0.post1", "1.0.post2.dev3", False),
            (">1.0,!=1.0.post1", "1.0.post1", False),
            (">1.0,!=1.0.post1", "1.1", True),
            (">2.3,!=2.3.post1", "2.3.post2", False),
            (">1!1.0,!=1!1.0.post1", "1!1.0.post2", False),
        ],
    )
    def test_contains_post_release_boundary_intersection(
        self, spec_str: str, version: str, expected: bool
    ) -> None:
        ss = SpecifierSet(spec_str)
        assert ss.contains(version, prereleases=True) == expected
        # set membership must equal the conjunction of its member specifiers
        assert ss.contains(version, prereleases=True) == all(
            s.contains(version, prereleases=True) for s in ss
        )

    def test_filter_post_release_boundary_intersection(self) -> None:
        ss = SpecifierSet(">1.0,!=1.0.post1")
        result = list(ss.filter(["1.0.post2", "1.0.post3", "1.1"], prereleases=True))
        assert result == ["1.1"]

    @pytest.mark.skipif(
        not hasattr(sys, "get_int_max_str_digits"),
        reason="requires int max str digits limit",
    )
    @pytest.mark.parametrize(
        "specifier",
        [
            ">=" + "1" * 5000,
            ">=1.0a" + "1" * 5000,
        ],
    )
    def test_contains_oversized_version_raises_valueerror(self, specifier: str) -> None:
        old = sys.get_int_max_str_digits()
        sys.set_int_max_str_digits(4300)
        try:
            spec = SpecifierSet(specifier)
            with pytest.raises(ValueError, match="Exceeds the limit"):
                spec.contains("1.0")
        finally:
            sys.set_int_max_str_digits(old)

    @pytest.mark.parametrize(
        ("version", "specifier", "expected"),
        [
            # Test arbitrary equality (===) with arbitrary strings
            ("foobar", "===foobar", True),
            ("foo", "===foobar", False),
            ("bar", "===foobar", False),
            # Test that === does not match with zero padding
            ("1.0", "===1.0", True),
            ("1.0.0", "===1.0", False),
            # Test that === does not match with local versions
            ("1.0", "===1.0+downstream1", False),
            ("1.0+downstream1", "===1.0", False),
            # Test === combined with other operators (arbitrary string)
            ("foobar", "===foobar,!=1.0", False),
            ("1.0", "===foobar,!=1.0", False),
            ("foobar", ">=1.0,===foobar", False),
            # Test === combined with other operators (version string)
            ("1.5", ">=1.0,===1.5", True),
            ("1.5", ">=2.0,===1.5", False),  # Doesn't meet >=2.0
            ("2.5", ">=1.0,===2.5", True),
            # Test != with invalid versions (should not pass as not valid versions)
            ("invalid", "!=1.0", False),
            ("foobar", "!=1.0", False),
            ("invalid", "!=2.0.*", False),
            # Test != with invalid versions combined with other operators
            ("invalid", "!=1.0,!=2.0", False),
            ("foobar", ">=1.0,!=2.0", False),
            ("1.5", ">=1.0,!=2.0", True),
        ],
    )
    def test_contains_arbitrary_equality_contains(
        self, version: str, specifier: str, expected: bool
    ) -> None:
        spec = SpecifierSet(specifier)
        assert spec.contains(version) == expected

    @pytest.mark.parametrize(
        ("spec_str", "version", "expected"),
        [
            # Zero padding: string preserves original, Version normalizes
            ("===1.1", "1.01", False),
            ("===1.01", "1.1", False),
            ("===1.01", "1.01", True),
            ("===1.1", "1.1", True),
            ("===1.1", Version("1.01"), True),
            ("===1.01", Version("1.01"), False),
            # Prerelease separator normalization
            ("===1.a1", "1.a1", True),
            ("===1a1", "1.a1", False),
            ("===1.a1", "1a1", False),
            ("===1a1", "1a1", True),
            ("===1.a1", Version("1.a1"), False),
            ("===1a1", Version("1.a1"), True),
            # Combined with other operators
            (">=1.0,===1.01", "1.01", True),
            (">=1.0,===1.1", "1.1", True),
            (">=1.0,===1.1", "1.01", False),
            (">=1.0,===1.1", Version("1.01"), True),
            (">=1.0,===1.01", Version("1.01"), False),
        ],
    )
    def test_contains_arbitrary_equality_normalization(
        self, spec_str: str, version: str | Version, expected: bool
    ) -> None:
        spec = SpecifierSet(spec_str, prereleases=True)
        assert spec.contains(version) == expected

    @pytest.mark.parametrize(
        ("specifier", "expected"),
        [
            # Single item specifiers should just be reflexive
            ("!=2.0", "!=2.0"),
            ("<2.0", "<2.0"),
            ("<=2.0", "<=2.0"),
            ("==2.0", "==2.0"),
            (">2.0", ">2.0"),
            (">=2.0", ">=2.0"),
            ("~=2.0", "~=2.0"),
            # Spaces should be removed
            ("< 2", "<2"),
            # Multiple item specifiers should work
            ("!=2.0,>1.0", "!=2.0,>1.0"),
            ("!=2.0 ,>1.0", "!=2.0,>1.0"),
        ],
    )
    def test_specifiers_str_and_repr(self, specifier: str, expected: str) -> None:
        spec = SpecifierSet(specifier)

        assert str(spec) == expected
        assert repr(spec) == f"<SpecifierSet({expected!r})>"

    @pytest.mark.parametrize("specifier", SPECIFIERS + LEGACY_SPECIFIERS)
    def test_specifiers_hash(self, specifier: str) -> None:
        assert hash(SpecifierSet(specifier)) == hash(SpecifierSet(specifier))

    @pytest.mark.parametrize(
        ("left", "right", "expected"), [(">2.0", "<5.0", ">2.0,<5.0")]
    )
    def test_specifiers_combine(self, left: str, right: str, expected: str) -> None:
        result = SpecifierSet(left) & SpecifierSet(right)
        assert result == SpecifierSet(expected)

        result = SpecifierSet(left) & right
        assert result == SpecifierSet(expected)

        result = SpecifierSet(left, prereleases=True) & SpecifierSet(right)
        assert result == SpecifierSet(expected)
        assert result.prereleases

        result = SpecifierSet(left, prereleases=False) & SpecifierSet(right)
        assert result == SpecifierSet(expected)
        assert not result.prereleases

        result = SpecifierSet(left) & SpecifierSet(right, prereleases=True)
        assert result == SpecifierSet(expected)
        assert result.prereleases

        result = SpecifierSet(left) & SpecifierSet(right, prereleases=False)
        assert result == SpecifierSet(expected)
        assert not result.prereleases

        result = SpecifierSet(left, prereleases=True) & SpecifierSet(
            right, prereleases=True
        )
        assert result == SpecifierSet(expected)
        assert result.prereleases

        result = SpecifierSet(left, prereleases=False) & SpecifierSet(
            right, prereleases=False
        )
        assert result == SpecifierSet(expected)
        assert not result.prereleases

        with pytest.raises(
            ValueError,
            match=re.escape(
                "Cannot combine SpecifierSets with True and False prerelease overrides."
            ),
        ):
            result = SpecifierSet(left, prereleases=True) & SpecifierSet(
                right, prereleases=False
            )

        with pytest.raises(
            ValueError,
            match=re.escape(
                "Cannot combine SpecifierSets with True and False prerelease overrides."
            ),
        ):
            result = SpecifierSet(left, prereleases=False) & SpecifierSet(
                right, prereleases=True
            )

    def test_specifiers_duplicate_normalization(self) -> None:
        # Specifiers that are equal but have different string representations
        # should be deduplicated for equality, hashing, and string output.
        a = SpecifierSet(">1.0.0,>1.0")
        b = SpecifierSet(">1.0")
        assert a == b
        assert hash(a) == hash(b)
        assert str(a) == str(b)

    def test_specifiers_combine_deduplicates(self) -> None:
        result = SpecifierSet(">=1.0") & SpecifierSet(">=1.0,<5.0")
        assert str(result) == "<5.0,>=1.0"

    def test_specifiers_combine_not_implemented(self) -> None:
        with pytest.raises(TypeError):
            SpecifierSet() & 12  # type: ignore[operator]

    @pytest.mark.parametrize(
        ("left", "right", "op"),
        list(
            itertools.chain.from_iterable(
                # Verify that the equal (==) operator works correctly
                [[(x, x, operator.eq) for x in SPECIFIERS]]
                +
                # Verify that the not equal (!=) operator works correctly
                [
                    [(x, y, operator.ne) for j, y in enumerate(SPECIFIERS) if i != j]
                    for i, x in enumerate(SPECIFIERS)
                ]
            )
        ),
    )
    def test_comparison_true(
        self, left: str, right: str, op: Callable[[object, object], bool]
    ) -> None:
        assert op(SpecifierSet(left), SpecifierSet(right))
        assert op(SpecifierSet(left), Specifier(right))
        assert op(Specifier(left), SpecifierSet(right))
        assert op(left, SpecifierSet(right))
        assert op(SpecifierSet(left), right)

    @pytest.mark.parametrize(
        ("left", "right", "op"),
        list(
            itertools.chain.from_iterable(
                # Verify that the equal (==) operator works correctly
                [[(x, x, operator.ne) for x in SPECIFIERS]]
                +
                # Verify that the not equal (!=) operator works correctly
                [
                    [(x, y, operator.eq) for j, y in enumerate(SPECIFIERS) if i != j]
                    for i, x in enumerate(SPECIFIERS)
                ]
            )
        ),
    )
    def test_comparison_false(
        self, left: str, right: str, op: Callable[[object, object], bool]
    ) -> None:
        assert not op(SpecifierSet(left), SpecifierSet(right))
        assert not op(SpecifierSet(left), Specifier(right))
        assert not op(Specifier(left), SpecifierSet(right))
        assert not op(left, SpecifierSet(right))
        assert not op(SpecifierSet(left), right)

    @pytest.mark.parametrize(("left", "right"), [("==2.8.0", "==2.8")])
    def test_comparison_canonicalizes(self, left: str, right: str) -> None:
        assert SpecifierSet(left) == SpecifierSet(right)
        assert left == SpecifierSet(right)
        assert SpecifierSet(left) == right

    def test_comparison_non_specifier(self) -> None:
        assert SpecifierSet("==1.0") != 12
        assert not SpecifierSet("==1.0") == 12

    @pytest.mark.parametrize(
        ("version", "specifier", "expected"),
        [
            ("1.0.0+local", "==1.0.0", True),
            ("1.0.0+local", "!=1.0.0", False),
            ("1.0.0+local", "<=1.0.0", True),
            ("1.0.0+local", ">=1.0.0", True),
            ("1.0.0+local", "<1.0.0", False),
            ("1.0.0+local", ">1.0.0", False),
        ],
    )
    def test_comparison_ignores_local(
        self, version: str, specifier: str, expected: bool
    ) -> None:
        assert (Version(version) in SpecifierSet(specifier)) == expected

    def test_contains_with_compatible_operator(self) -> None:
        combination = SpecifierSet("~=1.18.0") & SpecifierSet("~=1.18")
        assert "1.19.5" not in combination
        assert "1.18.0" in combination

    @pytest.mark.parametrize(
        ("spec1", "spec2", "input_versions"),
        [
            # Test zero padding
            ("===1.0", "===1.0.0", ["1.0", "1.0.0"]),
            ("===1.0.0", "===1.0", ["1.0", "1.0.0"]),
            ("===1.0", "===1.0.0", ["1.0.0", "1.0"]),
            ("===1.0.0", "===1.0", ["1.0.0", "1.0"]),
            # Test local versions
            ("===1.0", "===1.0+local", ["1.0", "1.0+local"]),
            ("===1.0+local", "===1.0", ["1.0", "1.0+local"]),
            ("===1.0", "===1.0+local", ["1.0+local", "1.0"]),
            ("===1.0+local", "===1.0", ["1.0+local", "1.0"]),
        ],
    )
    def test_arbitrary_equality_is_intersection_preserving(
        self, spec1: str, spec2: str, input_versions: list[str]
    ) -> None:
        """
        In general we expect for two specifiers s1 and s2, that the two statements
        are equivalent:
         * set((s1, s2).filter(versions))
         * set(s1.filter(versions)) & set(s2.filter(versions)).

        This is tricky with the arbitrary equality operator (===) since it does
        not follow normal version comparison rules.
        """
        s1 = Specifier(spec1)
        s2 = Specifier(spec2)
        versions1 = set(s1.filter(input_versions))
        versions2 = set(s2.filter(input_versions))
        combined_versions = set(SpecifierSet(f"{spec1},{spec2}").filter(input_versions))

        assert versions1 & versions2 == combined_versions


def _version_family(base: str) -> list[str]:
    """All PEP 440 suffixes and combinations around a base version."""
    return [
        f"{base}.dev0",
        f"{base}.dev1",
        f"{base}.dev0+local",
        f"{base}a0",
        f"{base}a0.post0.dev0",
        f"{base}a0.post0",
        f"{base}a1.dev1",
        f"{base}a1.dev1+local",
        f"{base}a1",
        f"{base}a1+local",
        f"{base}b1",
        f"{base}b2.post1.dev1",
        f"{base}b2.post1",
        f"{base}rc1.dev1",
        f"{base}rc1",
        f"{base}rc2",
        f"{base}a2.dev0",
        base,
        f"{base}.0",
        f"{base}.post0.dev0",
        f"{base}.post0",
        f"{base}.post1.dev0",
        f"{base}.post1",
        f"{base}.post1+local",
        f"{base}.post2",
        f"{base}+local",
        f"{base}+local1",
        f"{base}+local2",
        f"{base}+1",
        f"{base}+1.local",
        f"{base}.1.dev1",
        f"{base}.1a1",
        f"{base}.1",
        f"{base}.1+local",
        f"{base}.1.post1",
    ]


_SAMPLE_BASES: list[str] = [
    "0",
    "0.0",
    "1.0",
    "1.1",
    "1.2",
    "2.0",
    "2.1",
    "3.0",
    "1.0.1",
    "1.4.2",
    "2.0.0",
    "3.10.2",
    "3.8",
    "3.9",
    "3.10",
    "3.11",
    "3.12",
    "3.13",
    "3.14",
    "10.0",
    "100.0",
    "1!0.0",
    "1!1.0",
    "1!2.0",
]


def _build_sample_versions(
    bases: list[str], family_fn: Callable[[str], list[str]]
) -> list[str]:
    """version_family x bases, deduplicated.  Returns strings (not Version
    objects) so === can also match unnormalized and non-PEP-440 samples."""
    version_strs: list[str] = []
    for base in bases:
        version_strs.extend(family_fn(base))
    seen: set[str] = set()
    unique: list[str] = []
    for v in version_strs:
        if v not in seen:
            seen.add(v)
            unique.append(v)
    return unique


_SAMPLE_VERSIONS: list[str] = _build_sample_versions(_SAMPLE_BASES, _version_family)

# Extra strings for === (arbitrary equality): unnormalized forms and
# non-PEP-440 strings that no Version object can represent.
_SAMPLE_VERSIONS += [
    "foobar",
    "a",
    "b",
    "not-a-version",
    "1.01",
    "1.0-1",
    "v1.0",
]


class TestIsUnsatisfiable:
    """Tests for SpecifierSet.is_unsatisfiable().

    Testing approach:
    - UNSATISFIABLE: detected as unsatisfiable, filter returns nothing.
    - SATISFIABLE: not falsely reported as unsatisfiable.
    """

    UNSATISFIABLE: typing.ClassVar[list[str]] = [
        # Synthetic gaps: >V excludes V's post-releases, so the least version
        # >1.0a1 admits is 1.0a2.dev0, which <1.0a2.dev0 excludes (#1267).
        ">1.0a1,<1.0a2.dev0",
        ">1!1.0a1,<1!1.0a2.dev0",
        ">1.0b0,<1.0b1.dev0",
        ">1.0,<1.0.post0.dev0",
        # Floor: an exclusive upper at or below 0.dev0 strands an empty interval
        "!=0.dev0,<0.dev1",
        "!=0.dev0,<=0.dev0",
        # Crossed bounds
        ">=2.0,<1.0",
        ">=2.0,<2.0",
        ">2.0,<=2.0",
        ">2.0,<2.0",
        # Equality conflicts
        "==1.0,!=1.0",
        "==1.0,>1.0",
        "==1.0,<1.0",
        "==1.0,>=2.0",
        "==3.0,<2.0",
        # Wildcard conflicts
        "==1.*,>=2.0",
        "==2.*,<2.0.dev0",
        "==3.*,<3.0.dev0",
        "==1.0.*,!=1.0.*",
        "==1.0,!=1.*",
        # Compatible release conflicts
        "~=2.0,<2.0",
        "~=2.0,>=3.0",
        "~=2.5,<2.5",
        "~=1.0,>=2.0",
        "~=1.4.2,<1.4.2",
        # Point range excluded
        ">=1.0,<=1.0,!=1.0",
        # Epoch conflicts
        "==1!1.0,==1.0",
        ">=1!1.0,<1.0",
        ">=1!0.0,<1.0",
        # Zero/dev edge cases
        "<0",
        "<0.0",
        "<0.0.dev0",
        ">=1.0,<0.0.dev0",
        # <V excludes prereleases of V when V is not a prerelease
        ">=1.0a1,<1.0",
        ">=1.0.dev0,<1.0",
        ">=1.0rc1,<1.0",
        # <V.postN excludes dev releases of V.postN
        ">=1.0.post1,<1.0.post1",
        ">=1.0.post1.dev0,<1.0.post1",
        # >V excludes posts of V; <V.postN bound leaves no room
        ">1.0,<1.0.post0",
        ">1.0,<1.0.post1",
        # >V.postN + <V.postN+1: no version exists in the gap
        ">1.0.post0,<1.0.post1",
        # dev crossing
        ">=1.0.dev5,<1.0.dev3",
        # == with dev/pre/post + > same version
        "==1.0.dev0,>1.0.dev0",
        "==1.0a1,>1.0a1",
        "==1.0.post1,>1.0.post1",
        # >V.preN excludes posts of V.preN; nothing between
        ">1.0a1,<1.0a1.post1",
        # ~= with dev/pre + conflicting range
        "~=1.0.dev0,>=2.0",
        "~=1.0a1,>=2.0",
        # Wildcard exhausts range
        ">=1.0,<2.0,!=1.*",
        "~=1.4.2,!=1.4.*",
        # Local version conflicts
        "==1.0+local,!=1.0+local",
        # === conflicts: multiple === with different strings
        "===a,===b",
        "===1.0,===2.0",
        # === with unparsable + standard spec
        "===foobar,==1.0",
        "===foobar,>=1.0",
        "===a,!=1.0",
        "===not-a-version,~=1.0",
        "===foobar,>=2.0,<3.0",
        # === with parsable version that fails standard specs
        "===1.0,>=2.0",
        "===1.0,!=1.0",
        "===1.0,>1.0",
        "===1.01,==1.0",
        # Non-overlapping wildcards (adjacent boundaries, upper exclusive)
        "==1.0.*,==1.1.*",
        "==1.*,==2.*",
        # Conflicting compatible releases
        "~=1.0,~=2.0",
        "~=1.4.2,~=1.5.0",
        # Local excluded by non-local != (locals ignored per spec)
        "==1.0+local1,!=1.0",
        # Wildcard exhaustion (single and multiple)
        ">=1.0,<1.1,!=1.0.*",
        "!=1.*,!=2.*,>=1.0,<3.0",
        "~=1.0,!=1.*",
        # >V excludes posts of pre-release V
        ">1.0a1,<1.0a1.post2",
        # Adjacent dev of zero: no version between devN and dev(N+1)
        ">0.dev0,<0.dev1",
        # Compatible release with pre/dev suffix vs <base
        "~=1.0a1,<1.0",
        "~=1.0.dev5,<1.0",
        # Between post dev and post: >V.postK.devN leaves no room
        ">1.0.post0.dev0,<1.0.post0",
        # Deep release crossing compatible release boundary
        "~=1.2.3.4.5,>=1.2.3.5",
        # Different base but release is above the <V.postN bound
        "==1.1.dev0,<1.0.post1",
    ]

    SATISFIABLE: typing.ClassVar[list[str]] = [
        "",
        ">=1.0",
        "<2.0",
        ">1.0",
        ">=1.0,<2.0",
        ">=1.0,<=1.0",
        ">=1.0,<100.0",
        # Compatible release
        "~=1.0",
        "~=1.0,<1.5",
        "~=1.4.2",
        # Wildcards
        "==1.0.*",
        "!=1.0.*",
        "==1.*,!=1.5",
        "==1.0.*,==1.*",
        "!=1.*,>=2.0",
        # Exclusions that don't exhaust range
        ">=1.0,<2.0,!=1.5,!=1.6",
        ">=1.0,<2.0,!=1.0,!=1.1,!=1.2,!=1.3,!=1.4",
        # Single operators
        "==1.0",
        "!=1.0",
        # Prerelease ranges
        ">=1.0.dev0,<1.0.dev1",
        ">=1.0a1,<1.0a2",
        # Pre-release ranges with room between
        ">1.0a1,<1.0a2",
        ">=1.0a1,<1.0b1",
        ">=1.0b1,<1.0rc1",
        # Post-release ranges
        ">1.0.post0,<1.0.post2",
        ">1.0.post0,<1.0.post3",
        # Dev range within a release
        ">=1.0a1.dev0,<1.0a1",
        # Epoch
        ">=1!1.0,<1!2.0",
        ">1!1.0,<1!3.0",
        # Wildcards that don't exhaust range
        ">=1.0,<3.0,!=2.*",
        # Real-world
        ">=3.8,!=3.9.*,!=3.10.0,!=3.10.1,~=3.10.2,<3.14",
        # Boundary checks
        "<1.0.dev1",
        ">1!1.0",
        "<1!2.0",
        ">1.0,<3.0",
        ">1.0,>2.0",
        "<2.0,<3.0",
        ">1.0.post0",
        ">1.0.post1,<2.0",
        # Local versions (spec with local + spec without local that strips local)
        "==1.0+local1,>=1.0",
        "!=1.0+local1,>=1.0",
        "==1.0,>=0.5",
        "==1.0,!=0.5",
        "==1.0,<=2.0",
        "==1.0+local1,!=1.0+local2",
        "==1.0+local1,==1.0",
        "==1.0+local1,<=1.0",
        "==1.0+local,>=1.0,<=1.0",
        "==1.0.post1+local,<=1.0.post1",
        # Various multi-spec
        ">1.0,!=0.5",
        ">=1.0,<2.0rc1",
        ">=0.5,!=1.0.*",
        "~=1.0,!=1.3",
        ">=1!0.0,<1!1.0",
        # === (arbitrary string equality)
        "===foobar",
        "===1.0",
        "===1.0a1",
        # === with unnormalized version string (PR #1124)
        "===1.01",
        # === mixed with standard operators
        "===1.0,==1.0",
        "===1.0,>=1.0",
        "===1.0,>=0.5",
        "===1.0,!=2.0",
        "===1.0.0,>=1.0",
        "===1.01,>=1.0",
        # === with unnormalized version that parses to a matching version
        "===1.01,==1.1",
        # === case-insensitive identity
        "===FOOBAR,===foobar",
        "===FooBar,===FOOBAR",
        # Final version sits below its own post-releases
        ">=1.0,<1.0.post0",
        ">=1.0,<1.0.post1",
        # Lower bound below base.dev0: other-base versions survive
        ">=0,<1.0.post0,!=1.0",
        # <V.postN only excludes pre-releases of V.postN itself,
        # not pre-releases of the base release (#1140)
        "==1.0.dev0,<1.0.post1",
        "==1.0a1,<1.0.post0",
        "==1.0rc1,<1.0.post0",
        "==1.0.post0.dev0,<1.0.post1",
        ">=1.0.dev0,<1.0.post1,!=1.0,!=1.0.post0",
        # === with normalization variants
        "===v1.0,>=1.0",
        "===1.0-1,>=1.0",
        # Zero-padding equivalence
        "==1.0,==1.0.0",
        # Compatible release with post suffix
        "~=1.0.post1,>=1.0",
        # Range below post dev
        ">=1.0,<1.0.post0.dev1",
        # Post of alpha satisfies (1.0a1.post0 exists)
        ">=1.0a1,<1.0a2,!=1.0a1",
        # Alpha-to-beta range has room (1.0a2.dev0, etc.)
        ">1.0a1,<1.0b1",
        # Overlapping compatible releases
        "~=1.0,~=1.1",
        "~=1.0,~=1.0.1",
        # Partial wildcard exclusion doesn't exhaust range
        ">=1.0,<2.0,!=1.0.*,!=1.1.*",
        # ~= with pre/dev lower bound still accepts the final release
        "~=1.0.dev0,<1.0.post0",
        "~=1.0a1,<1.0.post0",
    ]

    @pytest.mark.parametrize("spec_str", UNSATISFIABLE)
    def test_unsatisfiable(self, spec_str: str) -> None:
        """Unsatisfiable specs must be detected, and filter must return empty."""
        ss = SpecifierSet(spec_str)
        assert ss.is_unsatisfiable(), f"Expected unsatisfiable: {spec_str!r}"
        result = list(ss.filter(_SAMPLE_VERSIONS, prereleases=True))
        assert result == [], (
            f"is_unsatisfiable() but filter matched: "
            f"{[str(v) for v in result]} for {spec_str!r}"
        )

    @pytest.mark.parametrize("spec_str", SATISFIABLE)
    def test_satisfiable(self, spec_str: str) -> None:
        """Satisfiable specs must not be falsely reported, and filter must match."""
        ss = SpecifierSet(spec_str)
        assert not ss.is_unsatisfiable(), f"Expected satisfiable: {spec_str!r}"
        result = bool(next(iter(ss.filter(_SAMPLE_VERSIONS, prereleases=True)), None))
        assert result, f"Expected filter to match at least one version for {spec_str!r}"

    def test_result_is_cached(self) -> None:
        ss = SpecifierSet(">=2.0,<1.0")
        assert ss.is_unsatisfiable()
        assert ss._is_unsatisfiable is True
        assert ss.is_unsatisfiable()  # second call uses cache

    def test_cache_reset_on_prereleases_change(self) -> None:
        ss = SpecifierSet(">=1.0,<2.0")
        assert not ss.is_unsatisfiable()
        ss.prereleases = True
        assert ss._is_unsatisfiable is None

    UNSATISFIABLE_NO_PRE: typing.ClassVar[list[str]] = [
        # Only pre-releases in range
        ">=1.0.dev0,<1.0",
        ">=1.0a1,<1.0",
        ">=1.0rc1,<1.0",
        # Single pre-release pin
        "==1.0.dev0",
        "==1.0a1",
        "==1.0a1.post0",
        "==1.0.post0.dev0",
        "==0.dev0",
        # Ranges within one pre-release family
        ">=1.0a1,<1.0a2",
        ">=1.0b1,<1.0rc1",
        ">=1.0.dev0,<1.0.dev5",
        # Strict > on pre-release lower bound (BoundaryVersion path)
        ">1.0a1,<1.0a3",
        # != removes all non-pre-releases from range
        ">=1.0rc1,<=1.0,!=1.0",
        ">=1.0.dev0,<=1.0,!=1.0",
        ">=1.0.dev0,<=1.0.post0,!=1.0,!=1.0.post0",
        # Epoch pre-release
        "==1!1.0.dev0",
        ">=1!1.0a1,<1!1.0",
        # === with parseable pre-release string
        "===1.0a1",
        "===1.0.dev0",
        # Floor: only members are pre-releases (#1267)
        "<0.dev1",
        "<=0.dev0",
        "<0a1",
        # Already unsatisfiable regardless of prereleases
        ">=2.0,<1.0",
    ]

    SATISFIABLE_NO_PRE: typing.ClassVar[list[str]] = [
        "",
        ">=1.0,<2.0",
        ">=1.0.dev0,<2.0",
        "==1.0",
        "==1.0.post0",
        ">=1.0.dev0,<1.0.post1",
        # Unbounded lower (nearest_non_prerelease(None) path)
        "<2.0",
        # Exact local pin: nearest == upper and upper inclusive
        "==1.0+local",
        # === forces range fallback in prerelease check
        "===1.0",
        # === with unparsable string (prereleases filter does not apply)
        "===foobar",
        # Compatible release from pre-release includes final release
        "~=1.0a1",
        "~=1.0.dev0",
        # != removes some but not all
        ">=1.0rc1,<=1.0.post0,!=1.0",
        # Inclusive upper at non-pre-release boundary
        ">=1.0rc1,<=1.0",
        ">=1.0.dev0,<=1.0",
        # Pre-release-with-post lower: the final release still satisfies (#1267)
        ">=1.0a1.post0,<=1.0",
        ">=1.0.post0.dev0,<=1.0.post0",
    ]

    @pytest.mark.parametrize("spec_str", UNSATISFIABLE_NO_PRE)
    def test_unsatisfiable_prereleases_false(self, spec_str: str) -> None:
        """With prereleases=False, detected as unsatisfiable and
        filter returns nothing."""
        ss = SpecifierSet(spec_str, prereleases=False)
        assert ss.is_unsatisfiable(), f"Expected unsatisfiable: {spec_str!r}"
        result = list(ss.filter(_SAMPLE_VERSIONS))
        assert result == [], (
            f"is_unsatisfiable() but filter matched: "
            f"{[str(v) for v in result]} for {spec_str!r}"
        )

    @pytest.mark.parametrize("spec_str", SATISFIABLE_NO_PRE)
    def test_satisfiable_prereleases_false(self, spec_str: str) -> None:
        """With prereleases=False, not falsely reported and filter matches."""
        ss = SpecifierSet(spec_str, prereleases=False)
        assert not ss.is_unsatisfiable(), f"Expected satisfiable: {spec_str!r}"
        result = bool(next(iter(ss.filter(_SAMPLE_VERSIONS)), None))
        assert result, f"Expected filter to match at least one version for {spec_str!r}"

    def test_and_preserves_unsatisfiable(self) -> None:
        combined = SpecifierSet(">=2.0") & SpecifierSet("<1.0")
        assert combined.is_unsatisfiable()

    def test_and_satisfiable(self) -> None:
        combined = SpecifierSet(">=1.0") & SpecifierSet("<2.0")
        assert not combined.is_unsatisfiable()

    @pytest.mark.parametrize(
        "spec_str",
        [
            ">1.0,<=1.0.post1",
            ">1.0,<=1.0.post5",
            ">2.3,<=2.3.post1",
            ">1!1.0,<=1!1.0.post1",
        ],
    )
    def test_post_release_boundary_unsatisfiable(self, spec_str: str) -> None:
        # ">V" excludes every "V.postN", so ">V,<=V.postN" admits no version.
        ss = SpecifierSet(spec_str)
        assert ss.is_unsatisfiable(), f"Expected unsatisfiable: {spec_str!r}"

    def test_and_reuses_interval_cache(self) -> None:
        """Specifier interval cache is reused when specs are shared via &."""
        s1 = SpecifierSet(">=1.0")
        s2 = SpecifierSet("<2.0")
        # Compute intervals on the original sets first.
        assert not s1.is_unsatisfiable()
        assert not s2.is_unsatisfiable()
        # __and__ reuses the same Specifier objects, so _to_ranges()
        # hits the cache on those Specifier instances.
        combined = s1 & s2
        assert not combined.is_unsatisfiable()

    def test_canonicalization_keeps_range_cache(self) -> None:
        """Canonicalization must not discard the computed range cache.

        ``_canonical_specs`` only reorders and dedupes specs, which leaves
        the intersected ranges unchanged, so the expensive ``_ranges`` cache
        must survive a canonicalizing operation such as ``str()``.
        """
        ss = SpecifierSet(">=1.0,<2.0,!=1.5")
        # filter() builds and caches the intersected ranges, the same cache
        # the range path of contains() reuses.
        assert list(ss.filter(["1.2"])) == ["1.2"]
        assert ss._ranges is not None
        cached_ranges = ss._ranges
        # str() forces canonicalization (sort + dedup of the spec tuple).
        str(ss)
        # The range cache must still be present and unchanged.
        assert ss._ranges is cached_ranges
        # A subsequent contains() now reuses the surviving cache.
        assert ss.contains("1.2")
        assert ss._ranges is cached_ranges

    def test_canonicalization_keeps_unsatisfiable_cache(self) -> None:
        """Canonicalization must not discard the unsatisfiability cache."""
        ss = SpecifierSet(">=2.0,<1.0")
        assert ss.is_unsatisfiable()
        assert ss._is_unsatisfiable is True
        # Force canonicalization; the cached verdict must remain.
        str(ss)
        assert ss._is_unsatisfiable is True

    @pytest.mark.parametrize(
        ("spec", "versions"),
        [
            # Duplicate specifiers.
            (">=1.0,>=1.0,<2.0", ["0.5", "1.0", "1.5", "2.0", "2.5"]),
            # Unsorted order.
            ("<2.0,!=1.5,>=1.0", ["0.5", "1.0", "1.5", "1.9", "2.0"]),
            # != plus post-release edge cases.
            ("!=1.0,>=1.0", ["1.0", "1.0.post1", "1.1"]),
            (">1.0,!=1.0.post1", ["1.0", "1.0.post1", "1.0.post2", "1.1"]),
        ],
    )
    def test_contains_identical_across_canonicalization(
        self, spec: str, versions: list[str]
    ) -> None:
        """contains() results are stable before and after canonicalization."""
        before = {v: SpecifierSet(spec).contains(v) for v in versions}
        ss = SpecifierSet(spec)
        # Populate the range cache, then canonicalize via str().
        _ = {v: ss.contains(v) for v in versions}
        str(ss)
        after = {v: ss.contains(v) for v in versions}
        assert after == before

    def test_range_bounds_hashable_and_equal(self) -> None:
        """Range bounds are hashable and support equality."""
        a = Specifier(">1.0")._to_ranges()
        b = Specifier(">1.0")._to_ranges()
        for (al, au), (bl, bu) in zip(a, b):
            hash(al)
            hash(au)
            assert al == bl
            assert au == bu

    def test_range_bounds_repr(self) -> None:
        [(lower, upper)] = Specifier(">=1.0")._to_ranges()
        assert repr(lower) == "<LowerBound [<Version('1.0')>>"
        assert repr(upper) == "<UpperBound None)>"

        [(lower2, upper2)] = Specifier(">1.0")._to_ranges()
        assert (
            repr(lower2)
            == "<LowerBound (BoundaryVersion(<Version('1.0')>, AFTER_POSTS)>"
        )
        assert repr(upper2) == "<UpperBound None)>"

    def test_range_bounds_reject_foreign_comparison(self) -> None:
        # The bound classes only compare to their own kind; anything else
        # returns NotImplemented so Python falls back to identity.
        [(lower, upper)] = Specifier(">=1.0")._to_ranges()
        assert lower.__eq__(object()) is NotImplemented
        assert lower.__lt__(object()) is NotImplemented  # type: ignore[operator]
        assert upper.__eq__(object()) is NotImplemented
        assert upper.__lt__(object()) is NotImplemented  # type: ignore[operator]


@pytest.mark.parametrize(
    ("specifier", "spec_prereleases"),
    [
        (">=1.0", None),
        ("==2.1.*", None),
        ("!=2.2.*", None),
        ("~=2.0", None),
        (">=1.0.dev1", None),
        ("<1.0.post1", None),
        (">2.0.post1", None),
        ("<=5", None),
        (">=7.9a1", None),
        ("<1.0.dev1", None),
        ("===foobar", None),
        # With prereleases override
        (">=1.0", True),
        (">=1.0", False),
    ],
)
def test_pickle_specifier_roundtrip(
    specifier: str, spec_prereleases: bool | None
) -> None:
    # Make sure equality and str() work between a pickle/unpickle round trip.
    s = Specifier(specifier, prereleases=spec_prereleases)
    # Warm up caches before pickling to ensure they are excluded from state.
    _ = s.prereleases
    _ = s._to_ranges()
    loaded = pickle.loads(pickle.dumps(s))
    assert loaded == s
    assert str(loaded) == str(s)
    assert loaded.prereleases == s.prereleases


@pytest.mark.parametrize(
    ("specifiers", "ss_prereleases"),
    [
        (">=1.0,<2.0", None),
        ("~=1.0,!=1.1", None),
        (">=1.0.dev1,<2.0", None),
        ("", None),  # Empty
        (">=1.0,<2.0,!=1.5", None),
        # With prereleases override
        (">=1.0,<2.0", True),
        (">=1.0,<2.0", False),
    ],
)
def test_pickle_specifierset_roundtrip(
    specifiers: str, ss_prereleases: bool | None
) -> None:
    # Make sure equality and str() work between a pickle/unpickle round trip.
    ss = SpecifierSet(specifiers, prereleases=ss_prereleases)
    # Warm up caches before pickling to ensure they are excluded from state.
    _ = ss.prereleases
    _ = ss.is_unsatisfiable()
    list(ss.filter(["1.5"]))
    loaded = pickle.loads(pickle.dumps(ss))
    assert loaded == ss
    assert str(loaded) == str(ss)
    assert loaded.prereleases == ss.prereleases


def test_pickle_setstate_rejects_invalid_state() -> None:
    # Cover the TypeError branches in __setstate__ for invalid input.
    s = Specifier.__new__(Specifier)
    with pytest.raises(TypeError, match="Cannot restore Specifier"):
        s.__setstate__((1, 2, 3))  # Wrong tuple length
    with pytest.raises(TypeError, match="Cannot restore Specifier"):
        s.__setstate__(12345)  # Not a tuple or dict

    ss = SpecifierSet.__new__(SpecifierSet)
    with pytest.raises(TypeError, match="Cannot restore SpecifierSet"):
        ss.__setstate__((1, 2, 3))  # Wrong tuple length
    with pytest.raises(TypeError, match="Cannot restore SpecifierSet"):
        ss.__setstate__(12345)  # Not a tuple or dict


def test_pickle_specifier_setstate_rejects_malformed_legacy_state() -> None:
    # Verify validation catches malformed legacy slot-dict and dict formats.
    s = Specifier.__new__(Specifier)
    # Missing _spec key (legacy slot-dict format).
    with pytest.raises(TypeError, match="Cannot restore Specifier"):
        s.__setstate__((None, {"_prereleases": None}))
    # Missing _spec key (legacy dict format).
    with pytest.raises(TypeError, match="Cannot restore Specifier"):
        s.__setstate__({"_prereleases": None})
    # _spec is not a 2-tuple of strings.
    with pytest.raises(TypeError, match="Cannot restore Specifier"):
        s.__setstate__((("bad",), None))
    with pytest.raises(TypeError, match="Cannot restore Specifier"):
        s.__setstate__((None, {"_spec": 123}))
    # _prereleases is not bool|None.
    with pytest.raises(TypeError, match="Cannot restore Specifier"):
        s.__setstate__((("==", "1.0"), "yes"))


def test_pickle_specifierset_setstate_rejects_malformed_legacy_state() -> None:
    # Verify validation catches malformed legacy slot-dict and dict formats.
    ss = SpecifierSet.__new__(SpecifierSet)
    # _specs contains non-Specifier items (legacy slot-dict format).
    with pytest.raises(TypeError, match="Cannot restore SpecifierSet"):
        ss.__setstate__((None, {"_specs": {1, 2}, "_prereleases": None}))
    # _specs contains non-Specifier items (legacy dict format).
    with pytest.raises(TypeError, match="Cannot restore SpecifierSet"):
        ss.__setstate__({"_specs": {1, 2}, "_prereleases": None})


def test_pickle_specifierset_setstate_on_initialized_instance() -> None:
    # Cover the branch where hasattr(self, "_specs") is True in __setstate__.
    # This happens when __setstate__ is called on an already-initialized instance.
    ss = SpecifierSet(">=1.0")
    ss.__setstate__(((Specifier(">=2.0"),), None))
    assert ss == SpecifierSet(">=2.0")


def test_pickle_specifier_setstate_clears_cache() -> None:
    # Verify that __setstate__ resets all cached slots to their reset
    # values, regardless of what was cached before the call.
    s = Specifier("==1.*")
    # Warm up every cache slot.
    _ = s._to_ranges()  # populates _spec_version + _ranges
    assert s._spec_version is not None
    assert s._ranges is not None

    s.__setstate__((("==", "1.*"), None))

    assert s._spec_version is None
    assert s._ranges is None


def test_pickle_specifierset_setstate_clears_cache() -> None:
    # Verify that __setstate__ resets all cached slots, regardless of
    # what was cached before the call.
    ss = SpecifierSet(">=1.0,<2.0")
    # Warm up every cache slot.
    ss.is_unsatisfiable()  # populates _is_unsatisfiable + _ranges
    assert ss._is_unsatisfiable is not None
    assert ss._ranges is not None

    ss.__setstate__(((Specifier(">=3.0"), Specifier("<4.0")), None))

    assert ss._is_unsatisfiable is None
    assert ss._ranges is None


# Pickle bytes generated with packaging==25.0, Python 3.13.13, pickle protocol 2.
# Format: plain __dict__ (no __slots__). _spec is stored as a (operator, version) tuple
# and _prereleases as a separate key.
_PACKAGING_25_0_PICKLE_GE_3_10 = (
    b"\x80\x02cpackaging.specifiers\nSpecifier\nq\x00)\x81q\x01}q\x02"
    b"(X\x05\x00\x00\x00_specq\x03X\x02\x00\x00\x00>=q\x04X\x04\x00\x00"
    b"\x003.10q\x05\x86q\x06X\x0c\x00\x00\x00_prereleasesq\x07Nub."
)

_PACKAGING_25_0_PICKLE_SS_GE_3_10_LT_4_0 = (
    b"\x80\x02cpackaging.specifiers\nSpecifierSet\nq\x00)\x81q\x01}q\x02"
    b"(X\x06\x00\x00\x00_specsq\x03c__builtin__\nfrozenset\nq\x04]q\x05"
    b"(cpackaging.specifiers\nSpecifier\nq\x06)\x81q\x07}q\x08(X\x05\x00"
    b"\x00\x00_specq\tX\x02\x00\x00\x00>=q\nX\x04\x00\x00\x003.10q\x0b"
    b"\x86q\x0cX\x0c\x00\x00\x00_prereleasesq\rNubh\x06)\x81q\x0e}q\x0f"
    b"(h\tX\x01\x00\x00\x00<q\x10X\x03\x00\x00\x004.0q\x11\x86q\x12h\r"
    b"Nube\x85q\x13Rq\x14h\rNub."
)


def test_pickle_specifier_25_0_format_loads() -> None:
    # Verify that Specifier pickles created with packaging <= 25.x (plain __dict__)
    # can be loaded and produce correct Specifier objects.
    s = pickle.loads(_PACKAGING_25_0_PICKLE_GE_3_10)
    assert isinstance(s, Specifier)
    assert str(s) == ">=3.10"
    assert s == Specifier(">=3.10")
    assert s.operator == ">="
    assert s.version == "3.10"
    assert s.prereleases == Specifier(">=3.10").prereleases


def test_pickle_specifierset_25_0_format_loads() -> None:
    # Verify that SpecifierSet pickles created with packaging <= 25.x (plain __dict__,
    # _specs stored as a frozenset) can be loaded and produce correct objects.
    ss = pickle.loads(_PACKAGING_25_0_PICKLE_SS_GE_3_10_LT_4_0)
    assert isinstance(ss, SpecifierSet)
    assert ss == SpecifierSet(">=3.10,<4.0")
    assert "3.10" in ss
    assert "3.12" in ss
    assert "4.0" not in ss
    assert ss.prereleases is None


# Pickle bytes generated with packaging==26.0, Python 3.13.13, pickle protocol 2.
# Format: __slots__ (no __dict__), state is (None, {slot: value}). Includes
# _spec_version slot (a cached Version object, may be present or None).
_PACKAGING_26_0_PICKLE_GE_3_10 = (
    b"\x80\x02cpackaging.specifiers\nSpecifier\nq\x00)\x81q\x01N}q\x02"
    b"(X\x0c\x00\x00\x00_prereleasesq\x03NX\x05\x00\x00\x00_specq\x04"
    b"X\x02\x00\x00\x00>=q\x05X\x04\x00\x00\x003.10q\x06\x86q\x07X\r"
    b"\x00\x00\x00_spec_versionq\x08Nu\x86q\tb."
)

_PACKAGING_26_0_PICKLE_SS_GE_3_10_LT_4_0 = (
    b"\x80\x02cpackaging.specifiers\nSpecifierSet\nq\x00)\x81q\x01N}q\x02"
    b"(X\x0c\x00\x00\x00_prereleasesq\x03NX\x06\x00\x00\x00_specsq\x04"
    b"c__builtin__\nfrozenset\nq\x05]q\x06(cpackaging.specifiers\nSpecifier"
    b"\nq\x07)\x81q\x08N}q\t(h\x03NX\x05\x00\x00\x00_specq\nX\x02\x00"
    b"\x00\x00>=q\x0bX\x04\x00\x00\x003.10q\x0c\x86q\rX\r\x00\x00\x00"
    b"_spec_versionq\x0eh\x0ccpackaging.version\nVersion\nq\x0f)\x81q\x10"
    b"N}q\x11(X\x04\x00\x00\x00_devq\x12NX\x06\x00\x00\x00_epochq\x13K"
    b"\x00X\n\x00\x00\x00_key_cacheq\x14NX\x06\x00\x00\x00_localq\x15N"
    b"X\x05\x00\x00\x00_postq\x16NX\x04\x00\x00\x00_preq\x17NX\x08\x00"
    b"\x00\x00_releaseq\x18K\x03K\n\x86q\x19u\x86q\x1ab\x86q\x1bu\x86"
    b"q\x1cbh\x07)\x81q\x1dN}q\x1e(h\x03Nh\nX\x01\x00\x00\x00<q\x1fX"
    b'\x03\x00\x00\x004.0q \x86q!h\x0eh h\x0f)\x81q"N}q#(h\x12Nh\x13'
    b"K\x00h\x14Nh\x15Nh\x16Nh\x17Nh\x18K\x04K\x00\x86q$u\x86q%b\x86"
    b"q&u\x86q'be\x85q(Rq)u\x86q*b."
)


def test_pickle_specifier_26_0_slots_format_loads() -> None:
    # Verify that Specifier pickles created with packaging 26.0 (__slots__,
    # state is (None, {slot_dict})) can be loaded and produce correct objects.
    s = pickle.loads(_PACKAGING_26_0_PICKLE_GE_3_10)
    assert isinstance(s, Specifier)
    assert str(s) == ">=3.10"
    assert s == Specifier(">=3.10")
    assert s.operator == ">="
    assert s.version == "3.10"
    assert s.prereleases == Specifier(">=3.10").prereleases


def test_pickle_specifierset_26_0_slots_format_loads() -> None:
    # Verify that SpecifierSet pickles created with packaging 26.0 (__slots__,
    # state is (None, {slot_dict}), _specs stored as frozenset) can be loaded.
    ss = pickle.loads(_PACKAGING_26_0_PICKLE_SS_GE_3_10_LT_4_0)
    assert isinstance(ss, SpecifierSet)
    assert ss == SpecifierSet(">=3.10,<4.0")
    assert "3.10" in ss
    assert "3.12" in ss
    assert "4.0" not in ss
    assert ss.prereleases is None


# Pickle bytes generated with packaging==26.1, Python 3.13.13, pickle protocol 2.
# Format: __slots__ (no __dict__), state is (None, {slot: value}). Compared to 26.0,
# the slot dict now includes _ranges and _wildcard_split cache fields, and SpecifierSet
# adds _canonicalized, _has_arbitrary, _is_unsatisfiable, and _resolved_ops.
_PACKAGING_26_1_PICKLE_GE_3_10 = (
    b"\x80\x02cpackaging.specifiers\nSpecifier\nq\x00)\x81q\x01N}q\x02"
    b"(X\x0c\x00\x00\x00_prereleasesq\x03NX\x07\x00\x00\x00_rangesq\x04"
    b"NX\x05\x00\x00\x00_specq\x05X\x02\x00\x00\x00>=q\x06X\x04\x00\x00"
    b"\x003.10q\x07\x86q\x08X\r\x00\x00\x00_spec_versionq\tNX\x0f\x00"
    b"\x00\x00_wildcard_splitq\nNu\x86q\x0bb."
)

_PACKAGING_26_1_PICKLE_SS_GE_3_10_LT_4_0 = (
    b"\x80\x02cpackaging.specifiers\nSpecifierSet\nq\x00)\x81q\x01N}q\x02"
    b"(X\x0e\x00\x00\x00_canonicalizedq\x03\x89X\x0e\x00\x00\x00_has_arb"
    b"itraryq\x04\x89X\x11\x00\x00\x00_is_unsatisfiableq\x05NX\x0c\x00"
    b"\x00\x00_prereleasesq\x06NX\r\x00\x00\x00_resolved_opsq\x07NX\x06"
    b"\x00\x00\x00_specsq\x08cpackaging.specifiers\nSpecifier\nq\t)\x81q"
    b"\nN}q\x0b(h\x06NX\x07\x00\x00\x00_rangesq\x0cNX\x05\x00\x00\x00"
    b"_specq\rX\x02\x00\x00\x00>=q\x0eX\x04\x00\x00\x003.10q\x0f\x86q"
    b"\x10X\r\x00\x00\x00_spec_versionq\x11NX\x0f\x00\x00\x00_wildcard_"
    b"splitq\x12Nu\x86q\x13bh\t)\x81q\x14N}q\x15(h\x06Nh\x0cNh\rX\x01"
    b"\x00\x00\x00<q\x16X\x03\x00\x00\x004.0q\x17\x86q\x18h\x11Nh\x12N"
    b"u\x86q\x19b\x86q\x1au\x86q\x1bb."
)


def test_pickle_specifier_26_1_slots_format_loads() -> None:
    # Verify that Specifier pickles created with packaging 26.1 (__slots__,
    # state includes _ranges and _wildcard_split) can be loaded correctly.
    s = pickle.loads(_PACKAGING_26_1_PICKLE_GE_3_10)
    assert isinstance(s, Specifier)
    assert str(s) == ">=3.10"
    assert s == Specifier(">=3.10")
    assert s.operator == ">="
    assert s.version == "3.10"
    assert s.prereleases == Specifier(">=3.10").prereleases


def test_pickle_specifierset_26_1_slots_format_loads() -> None:
    # Verify that SpecifierSet pickles created with packaging 26.1 (__slots__,
    # state includes _canonicalized, _has_arbitrary, _is_unsatisfiable,
    # _resolved_ops, and _specs as a tuple) can be loaded correctly.
    ss = pickle.loads(_PACKAGING_26_1_PICKLE_SS_GE_3_10_LT_4_0)
    assert isinstance(ss, SpecifierSet)
    assert ss == SpecifierSet(">=3.10,<4.0")
    assert "3.10" in ss
    assert "3.12" in ss
    assert "4.0" not in ss
    assert ss.prereleases is None


# Pickle bytes generated with packaging==26.2.dev0 (the 26.2 clean-tuple format),
# Python 3.13.13, pickle protocol 2.
# Format: Specifier state is ((operator, version), prereleases). SpecifierSet state
# is (tuple[Specifier, ...], prereleases). No slot dicts or __dict__ wrappers.
_PACKAGING_26_2_PICKLE_GE_3_10 = (
    b"\x80\x02cpackaging.specifiers\nSpecifier\nq\x00)\x81q\x01X\x02\x00"
    b"\x00\x00>=q\x02X\x04\x00\x00\x003.10q\x03\x86q\x04N\x86q\x05b."
)

_PACKAGING_26_2_PICKLE_SS_GE_3_10_LT_4_0 = (
    b"\x80\x02cpackaging.specifiers\nSpecifierSet\nq\x00)\x81q\x01cpackag"
    b"ing.specifiers\nSpecifier\nq\x02)\x81q\x03X\x02\x00\x00\x00>=q\x04"
    b"X\x04\x00\x00\x003.10q\x05\x86q\x06N\x86q\x07bh\x02)\x81q\x08X\x01"
    b"\x00\x00\x00<q\tX\x03\x00\x00\x004.0q\n\x86q\x0bN\x86q\x0cb\x86q\r"
    b"N\x86q\x0eb."
)


def test_pickle_specifier_26_2_tuple_format_loads() -> None:
    # Verify that Specifier pickles created with packaging 26.2+ (compact 2-tuple
    # state: ((operator, version), prereleases)) load correctly.
    s = pickle.loads(_PACKAGING_26_2_PICKLE_GE_3_10)
    assert isinstance(s, Specifier)
    assert str(s) == ">=3.10"
    assert s == Specifier(">=3.10")
    assert s.operator == ">="
    assert s.version == "3.10"
    assert s.prereleases == Specifier(">=3.10").prereleases


def test_pickle_specifierset_26_2_tuple_format_loads() -> None:
    # Verify that SpecifierSet pickles created with packaging 26.2+ (compact 2-tuple
    # state: (tuple[Specifier, ...], prereleases)) load correctly.
    ss = pickle.loads(_PACKAGING_26_2_PICKLE_SS_GE_3_10_LT_4_0)
    assert isinstance(ss, SpecifierSet)
    assert ss == SpecifierSet(">=3.10,<4.0")
    assert "3.10" in ss
    assert "3.12" in ss
    assert "4.0" not in ss
    assert ss.prereleases is None


def test_filter_multirange_pep440_prerelease_after_final() -> None:
    """Multi-range PEP 440 path drops a prerelease that arrives after a final."""
    # `!=1.5` has two ranges: (-inf, 1.5) and (AFTER_LOCALS(1.5), +inf).
    ss = SpecifierSet("!=1.5")
    assert list(ss.filter(["1.4", "1.6a1"])) == ["1.4"]
    assert list(ss.filter(["1.6a1", "1.4"])) == ["1.4"]


@pytest.mark.parametrize(
    "spec",
    [
        ">0.5",
        ">=1.0",
        "<=2.0",
        "<3.0",
        "==1.5",
        "!=1.5",
        "==1.*",
        "!=1.0+local",
        "~=1.2.3",
        "===wat",
    ],
)
def test_specifier_construction_is_lazy(spec: str) -> None:
    s = Specifier(spec)
    assert s._spec_version is None
    assert s._ranges is None


@pytest.mark.parametrize(
    "spec",
    [
        "",
        ">=1.0",
        ">=1.0,<2.0",
        ">=3.8,!=3.9.*,!=3.10.0,!=3.10.1,~=3.10.2,<3.14,!=3.11.0",
        "===wat",
    ],
)
def test_specifierset_construction_is_lazy(spec: str) -> None:
    ss = SpecifierSet(spec)
    assert ss._is_unsatisfiable is None
    assert ss._ranges is None
    # Every inner Specifier must also be untouched.
    for inner in ss._specs:
        assert inner._spec_version is None
        assert inner._ranges is None


def test_specifier_filter_with_version_iterable_warms_then_reuses_cache() -> None:
    """filter() reuses warm _ranges and exercises the Version isinstance branch."""
    spec = Specifier(">=1.5")
    assert spec.contains(Version("2.0"))
    items = [Version("1.0"), Version("2.0"), Version("3.0")]
    assert list(spec.filter(items)) == [Version("2.0"), Version("3.0")]


@pytest.mark.parametrize(
    ("spec_str", "version_str", "expected"),
    [
        # >V (AFTER_POSTS): trimmed release longer than parsed.release
        (">1.2.3", "2", True),
        # !=V (AFTER_LOCALS upper-side): trimmed release longer than parsed
        ("!=1.2.3", "2", True),
        # <=V (AFTER_LOCALS upper): parsed > V cmpkey-wise but shorter release
        ("<=1.2.3", "2", False),
    ],
)
def test_boundary_closure_short_release(
    spec_str: str, version_str: str, expected: bool
) -> None:
    """Closures handle parsed versions whose release is shorter than the boundary's."""
    spec = Specifier(spec_str)
    version = Version(version_str)
    assert spec.contains(version) is expected
    # Also drive Specifier.filter directly: contains has a fast path that
    # bypasses the range closures for short releases, but filter does not.
    filtered = list(spec.filter([version], prereleases=True))
    assert (filtered == [version]) is expected


def test_filter_arbitrary_with_prereleases_false_skips_pre() -> None:
    """``===1.0a1`` with ``prereleases=False`` drops the pre-release."""
    spec = Specifier("===1.0a1")
    assert list(spec.filter(["1.0a1", "0.9"], prereleases=False)) == []


def test_filter_arbitrary_constructor_prereleases_false_skips_pre() -> None:
    """``Specifier('===1.0a1', prereleases=False)`` honors the constructor flag."""
    spec = Specifier("===1.0a1", prereleases=False)
    assert list(spec.filter(["1.0a1"])) == []
    assert spec.contains("1.0a1") is False


def test_filter_arbitrary_unparsable_uses_key() -> None:
    """``===`` filter with ``key=`` matches against the keyed value."""
    items = [{"v": "wat"}, {"v": "WAT"}, {"v": "else"}]
    spec = Specifier("===wat")
    assert list(spec.filter(items, key=lambda x: x["v"])) == [
        {"v": "wat"},
        {"v": "WAT"},
    ]


def test_filter_keyed_none_version_is_skipped() -> None:
    """Non-string keyed versions are skipped like other invalid versions."""
    items = [{"v": "1.0"}, {"v": None}, {"v": "2.0"}]
    spec = SpecifierSet(">=1")
    assert list(spec.filter(items, key=lambda x: x["v"])) == [  # type: ignore[index]
        {"v": "1.0"},
        {"v": "2.0"},
    ]


def test_filter_arbitrary_pep440_unparsable_buffer_flush() -> None:
    """``===wat`` flushes the unparsable buffer when no final ever lands."""
    # "wat" never parses, so no final can be reached for the literal
    # match. Two matching items both buffer and then flush at the end.
    spec = Specifier("===wat")
    assert list(spec.filter(["wat", "wat"])) == ["wat", "wat"]


def test_filter_arbitrary_pep440_pre_only() -> None:
    """``===1.0a1`` PEP 440 default: prerelease literal flushes without a final."""
    pre_spec = Specifier("===1.0a1")
    assert list(pre_spec.filter(["1.0a1"])) == ["1.0a1"]


def test_specifierset_contains_reads_cached_bounds() -> None:
    # ``filter`` populates the intersected bounds; ``contains`` then answers
    # from that cache rather than re-folding the specifiers. Poisoning the
    # cache with empty bounds (which match nothing) flips the answer, proving
    # ``contains`` reads ``_ranges`` instead of recomputing it.
    ss = SpecifierSet(">=1.0,!=1.5,<3.0")
    list(ss.filter([Version("2.0")]))
    assert ss._ranges is not None
    assert ss.contains("2.0") is True

    ss._ranges = ()
    assert ss.contains("2.0") is False


# Every shape ``SpecifierSet`` can take: each operator, wildcards, ``===``,
# epochs, pre/post/dev/local boundaries, multi-spec sets, and unsatisfiable
# sets. Used to prove ``to_range()`` preserves membership and filtering.
_EQUIV_SPECS = [
    "",
    ">=1.0",
    ">1.0",
    "<=1.0",
    "<1.0",
    "==1.0",
    "!=1.0",
    "~=1.4.2",
    "==1.2.*",
    "!=1.2.*",
    "==1.0+local",
    "!=1.0+local",
    ">=1.0a1",
    "<1.0rc1",
    ">2.0.post1",
    "<=1.0.post2",
    ">=1.0.dev1",
    "==2!1.0",
    ">=2!1.0,<2!2.0",
    "===foobar",
    "===1.0",
    ">=1.0,<2.0",
    ">=1.0,<2.0,!=1.5",
    "!=1.4,!=1.6",
    ">=1.0,<2.0,!=1.2.*",
    "==1.0,!=1.0",
    ">=2.0,<1.0",
    "<0",
]

# Versions and arbitrary strings that stress every boundary the engine tracks.
_EQUIV_ITEMS = [
    "0.dev0",
    "1.0.dev1",
    "1.0a1",
    "1.0rc1",
    "1.0",
    "1.0+local",
    "1.0.post1",
    "1.0.post2",
    "1.0.post3",
    "1.0.1",
    "1.2",
    "1.2.3",
    "1.4.2",
    "1.4.9",
    "1.5",
    "1.6",
    "2.0",
    "2.0.dev1",
    "2!1.0",
    "1.0.0",
    "foobar",
    "garbage",
]


def _parse_or_none(value: str) -> Version | None:
    try:
        return Version(value)
    except InvalidVersion:
        return None


_EQUIV_VERSION_OBJS = [v for v in map(_parse_or_none, _EQUIV_ITEMS) if v is not None]


class TestSpecifierSetToRangeEquivalence:
    """``SpecifierSet.to_range()`` answers ``contains`` and ``filter``
    identically to the originating :class:`SpecifierSet` for every shape,
    item, and pre-release setting."""

    @pytest.mark.parametrize("spec_str", _EQUIV_SPECS)
    @pytest.mark.parametrize("configured", [None, True, False])
    def test_contains_equivalent(self, spec_str: str, configured: bool | None) -> None:
        spec_set = SpecifierSet(spec_str, prereleases=configured)
        version_range = spec_set.to_range()
        for item in _EQUIV_ITEMS:
            assert (item in spec_set) == (item in version_range), (spec_str, item)
            for prereleases in (None, True, False):
                for installed in (None, True, False):
                    assert spec_set.contains(
                        item, prereleases=prereleases, installed=installed
                    ) == version_range.contains(
                        item, prereleases=prereleases, installed=installed
                    ), (spec_str, item, prereleases, installed)

    @pytest.mark.parametrize("spec_str", _EQUIV_SPECS)
    @pytest.mark.parametrize("configured", [None, True, False])
    def test_filter_equivalent(self, spec_str: str, configured: bool | None) -> None:
        spec_set = SpecifierSet(spec_str, prereleases=configured)
        version_range = spec_set.to_range()
        for prereleases in (None, True, False):
            assert list(spec_set.filter(_EQUIV_ITEMS, prereleases=prereleases)) == list(
                version_range.filter(_EQUIV_ITEMS, prereleases=prereleases)
            ), (spec_str, prereleases)

    @pytest.mark.parametrize("spec_str", _EQUIV_SPECS)
    def test_contains_equivalent_with_version_objects(self, spec_str: str) -> None:
        # The same equivalence holds when the item is a ``Version`` instance.
        spec_set = SpecifierSet(spec_str)
        version_range = spec_set.to_range()
        for version in _EQUIV_VERSION_OBJS:
            assert (version in spec_set) == (version in version_range), (
                spec_str,
                version,
            )
            assert spec_set.contains(version) == version_range.contains(version)
