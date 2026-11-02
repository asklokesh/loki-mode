import pytest

from forms import ValidationError
from forms.validators import validate_phone

INVALID = "must be a valid phone number"


def test_us_ten_digits_get_plus_one():
    assert validate_phone("(415) 555-0123") == "+14155550123"
    assert validate_phone("415.555.0123") == "+14155550123"


def test_us_eleven_digits_with_leading_one():
    assert validate_phone("1 415 555 0123") == "+14155550123"


def test_international_with_plus():
    assert validate_phone(" +44 20 7946 0958 ") == "+442079460958"
    assert validate_phone("+49-30-1234-5678") == "+493012345678"
    assert validate_phone("+12345678") == "+12345678"
    assert validate_phone("+" + "9" * 15) == "+" + "9" * 15


def test_phone_required():
    with pytest.raises(ValidationError) as err:
        validate_phone("   ")
    assert str(err.value) == "phone: is required"


@pytest.mark.parametrize(
    "bad",
    ["555-0123", "41555501234", "21555501234", "+1234567", "+" + "9" * 16, "415-555-012a", "+44+2079460958", "415_555_0123"],
)
def test_phone_rejects(bad):
    with pytest.raises(ValidationError) as err:
        validate_phone(bad)
    assert str(err.value) == f"phone: {INVALID}"


def test_phone_custom_field_name():
    with pytest.raises(ValidationError) as err:
        validate_phone("12", field="mobile")
    assert err.value.field == "mobile"
    assert err.value.message == INVALID
