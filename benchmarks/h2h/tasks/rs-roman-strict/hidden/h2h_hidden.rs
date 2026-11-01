use romankit::{from_roman, to_roman, RomanError};

#[test]
fn trailing_subtractive_pairs_parse() {
    assert_eq!(from_roman("IV"), Ok(4));
    assert_eq!(from_roman("IX"), Ok(9));
    assert_eq!(from_roman("XIX"), Ok(19));
    assert_eq!(from_roman("MCMXCIV"), Ok(1994));
    assert_eq!(from_roman("MMMCMXCIX"), Ok(3999));
}

#[test]
fn every_value_round_trips() {
    for n in 1..=3999 {
        let s = to_roman(n).unwrap();
        assert_eq!(from_roman(&s), Ok(n), "round trip of {n} via {s}");
    }
}

#[test]
fn to_roman_rejects_out_of_range() {
    assert_eq!(to_roman(0), Err(RomanError::OutOfRange));
    assert_eq!(to_roman(4000), Err(RomanError::OutOfRange));
    assert_eq!(to_roman(u32::MAX), Err(RomanError::OutOfRange));
}

#[test]
fn to_roman_still_formats_valid_values() {
    assert_eq!(to_roman(444).unwrap(), "CDXLIV");
    assert_eq!(to_roman(3888).unwrap(), "MMMDCCCLXXXVIII");
}

#[test]
fn empty_string_is_empty_error() {
    assert_eq!(from_roman(""), Err(RomanError::Empty));
}

#[test]
fn lowercase_is_invalid_char() {
    assert_eq!(from_roman("xiv"), Err(RomanError::InvalidChar('x')));
    assert_eq!(from_roman("Xiv"), Err(RomanError::InvalidChar('i')));
}

#[test]
fn first_invalid_char_is_reported() {
    assert_eq!(from_roman("XIZ"), Err(RomanError::InvalidChar('Z')));
    assert_eq!(from_roman(" X"), Err(RomanError::InvalidChar(' ')));
    assert_eq!(from_roman("IIIIA9"), Err(RomanError::InvalidChar('A')));
}

#[test]
fn repeated_numerals_are_non_canonical() {
    for s in ["IIII", "VV", "XXXX", "LL", "CCCC", "DD", "MMMM", "VIIII"] {
        assert_eq!(from_roman(s), Err(RomanError::NonCanonical), "{s}");
    }
}

#[test]
fn bad_subtractive_pairs_are_non_canonical() {
    for s in [
        "IC", "IL", "VX", "XM", "XD", "IIV", "IXIX", "XCX", "CMM", "IVI",
    ] {
        assert_eq!(from_roman(s), Err(RomanError::NonCanonical), "{s}");
    }
}

#[test]
fn very_long_input_is_non_canonical() {
    let s = "M".repeat(5000);
    assert_eq!(from_roman(&s), Err(RomanError::NonCanonical));
}
