import textkit
from textkit import transforms


def test_values():
    assert transforms.strip_accents("Crème Brûlée") == "Creme Brulee"
    assert transforms.strip_accents("naïve café") == "naive cafe"
    assert transforms.strip_accents("Ångström") == "Angstrom"
    assert transforms.strip_accents("plain ASCII 123!") == "plain ASCII 123!"
    assert transforms.strip_accents("") == ""


def test_conventions():
    assert "strip_accents" in transforms.__all__
    assert textkit.strip_accents is transforms.strip_accents
    assert ">>> " in (transforms.strip_accents.__doc__ or "")
