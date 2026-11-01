import pytest

from forms import ValidationError
from forms.validators import validate_required, validate_username


def test_required_strips():
    assert validate_required("  ann ", "name") == "ann"


def test_required_rejects_blank():
    with pytest.raises(ValidationError) as err:
        validate_required("   ", "name")
    assert err.value.field == "name"
    assert err.value.message == "is required"
    assert str(err.value) == "name: is required"


def test_required_treats_none_as_blank():
    with pytest.raises(ValidationError):
        validate_required(None, "name")


def test_username_lowercases():
    assert validate_username(" Ann_99 ") == "ann_99"


def test_username_rules():
    for bad in ["ab", "a" * 17, "ann-b", "ann b"]:
        with pytest.raises(ValidationError) as err:
            validate_username(bad)
        assert str(err.value) == "username: must be 3 to 16 letters, digits or underscores"
    with pytest.raises(ValidationError) as err:
        validate_username("", field="login")
    assert str(err.value) == "login: is required"
