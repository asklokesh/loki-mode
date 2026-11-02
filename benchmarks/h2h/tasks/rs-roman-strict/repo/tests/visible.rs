use romankit::{from_roman, to_roman};

#[test]
fn formats_common_numbers() {
    assert_eq!(to_roman(1).unwrap(), "I");
    assert_eq!(to_roman(4).unwrap(), "IV");
    assert_eq!(to_roman(9).unwrap(), "IX");
    assert_eq!(to_roman(58).unwrap(), "LVIII");
    assert_eq!(to_roman(1994).unwrap(), "MCMXCIV");
    assert_eq!(to_roman(3999).unwrap(), "MMMCMXCIX");
}

#[test]
fn parses_additive_numerals() {
    assert_eq!(from_roman("III"), Ok(3));
    assert_eq!(from_roman("LVIII"), Ok(58));
    assert_eq!(from_roman("MDCLXVI"), Ok(1666));
}

#[test]
fn parses_leading_subtractive_pairs() {
    assert_eq!(from_roman("CDXLIII"), Ok(443));
    assert_eq!(from_roman("MCMLXXX"), Ok(1980));
}
