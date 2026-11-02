import pytest

from forms import ValidationError
from forms.validators import validate_email

INVALID = "must be a valid email address"


def test_email_is_stripped_and_lowercased():
    assert validate_email("  Ann.Lee+news@Example.CO.uk ") == "ann.lee+news@example.co.uk"
    assert validate_email("a_b%c-d@x-y.io") == "a_b%c-d@x-y.io"


def test_email_required():
    with pytest.raises(ValidationError) as err:
        validate_email("  ")
    assert str(err.value) == "email: is required"


def test_email_custom_field_name():
    with pytest.raises(ValidationError) as err:
        validate_email("nope", field="contact")
    assert err.value.field == "contact"
    assert err.value.message == INVALID


@pytest.mark.parametrize("bad", ["annexample.com", "a@b@c.com", "@x.io", "ann@", "ann lee@x.io", "ann!@x.io"])
def test_email_at_sign_and_local_charset(bad):
    with pytest.raises(ValidationError) as err:
        validate_email(bad)
    assert str(err.value) == f"email: {INVALID}"


@pytest.mark.parametrize("bad", [".ann@x.io", "ann.@x.io", "an..n@x.io", "a" * 65 + "@x.io"])
def test_email_local_part_dots_and_length(bad):
    with pytest.raises(ValidationError):
        validate_email(bad)


def test_email_local_part_of_64_is_fine():
    assert validate_email("a" * 64 + "@x.io") == "a" * 64 + "@x.io"


@pytest.mark.parametrize("bad", ["ann@localhost", "ann@-x.io", "ann@x-.io", "ann@x..io", "ann@x.i", "ann@x.c0m", "ann@x_y.io"])
def test_email_domain_rules(bad):
    with pytest.raises(ValidationError):
        validate_email(bad)
