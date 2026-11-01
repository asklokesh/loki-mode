import pytest

from forms import ValidationError
from forms.validators import (
    VALIDATORS,
    validate_email,
    validate_form,
    validate_phone,
    validate_postcode,
    validate_required,
    validate_username,
)


def test_us_postcodes():
    assert validate_postcode(" 94105 ", "US") == "94105"
    assert validate_postcode("94105-1234", "us") == "94105-1234"
    for bad in ["9410", "941051", "94105-123", "94105 1234", "ABCDE"]:
        with pytest.raises(ValidationError) as err:
            validate_postcode(bad, "US")
        assert str(err.value) == "postcode: must be a valid postcode"


def test_canadian_postcodes():
    assert validate_postcode("k1a0b1", "CA") == "K1A 0B1"
    assert validate_postcode(" K1A 0B1 ", "ca") == "K1A 0B1"
    for bad in ["K1A  0B1", "1KA 0B1", "K1A0B", "K1A-0B1"]:
        with pytest.raises(ValidationError):
            validate_postcode(bad, "CA")


def test_postcode_required_and_unsupported_country():
    with pytest.raises(ValidationError) as err:
        validate_postcode("", "US", field="zip")
    assert str(err.value) == "zip: is required"
    with pytest.raises(ValidationError) as err:
        validate_postcode("12345", "fr")
    assert str(err.value) == "postcode: unsupported country FR"


def test_registry_names():
    assert VALIDATORS == {
        "required": validate_required,
        "username": validate_username,
        "email": validate_email,
        "phone": validate_phone,
        "postcode": validate_postcode,
    }


def test_validate_form_all_good():
    data = {"username": " Ann_1 ", "email": "Ann@X.io", "phone": "(415) 555-0123", "zip": "k1a 0b1", "extra": "ignored"}
    schema = {"username": "username", "email": "email", "phone": "phone", "zip": "postcode:CA"}
    assert validate_form(data, schema) == (
        {"username": "ann_1", "email": "ann@x.io", "phone": "+14155550123", "zip": "K1A 0B1"},
        {},
    )


def test_validate_form_collects_errors_in_schema_order():
    data = {"email": "nope", "name": "  ", "zip": "123"}
    schema = {"name": "required", "email": "email", "zip": "postcode:US", "phone": "phone"}
    cleaned, errors = validate_form(data, schema)
    assert cleaned == {}
    assert errors == {
        "name": "is required",
        "email": "must be a valid email address",
        "zip": "must be a valid postcode",
        "phone": "is required",
    }
    assert list(errors) == ["name", "email", "zip", "phone"]


def test_validate_form_mixed_and_unknown_validator():
    cleaned, errors = validate_form({"a": "x", "b": "bad"}, {"a": "required", "b": "email"})
    assert cleaned == {"a": "x"}
    assert errors == {"b": "must be a valid email address"}
    with pytest.raises(ValueError) as err:
        validate_form({"a": "x"}, {"a": "zipcode"})
    assert str(err.value) == "unknown validator 'zipcode'"
