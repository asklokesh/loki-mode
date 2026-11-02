from textkit import transforms


def test_slugify():
    assert transforms.slugify("Rust & Go: 2024 Edition") == "rust-go-2024-edition"


def test_title_case():
    assert transforms.title_case("war AND peace") == "War and Peace"
