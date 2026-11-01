use std::fmt;

/// Errors returned by the conversion functions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RomanError {
    Empty,
    InvalidChar(char),
    NonCanonical,
    OutOfRange,
}

impl fmt::Display for RomanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RomanError::Empty => write!(f, "empty numeral"),
            RomanError::InvalidChar(c) => write!(f, "invalid character {c:?}"),
            RomanError::NonCanonical => write!(f, "numeral is not in canonical form"),
            RomanError::OutOfRange => write!(f, "value out of range 1..=3999"),
        }
    }
}

impl std::error::Error for RomanError {}

const TABLE: [(u32, &str); 13] = [
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XC"),
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
];

/// The longest canonical numeral, MMMDCCCLXXXVIII (3888), has 15 characters.
const MAX_LEN: usize = 15;

/// Converts a number in 1..=3999 to its canonical Roman numeral.
pub fn to_roman(n: u32) -> Result<String, RomanError> {
    if !(1..=3999).contains(&n) {
        return Err(RomanError::OutOfRange);
    }
    let mut rest = n;
    let mut out = String::new();
    for (value, digits) in TABLE {
        while rest >= value {
            out.push_str(digits);
            rest -= value;
        }
    }
    Ok(out)
}

fn digit_value(c: char) -> Option<u32> {
    match c {
        'I' => Some(1),
        'V' => Some(5),
        'X' => Some(10),
        'L' => Some(50),
        'C' => Some(100),
        'D' => Some(500),
        'M' => Some(1000),
        _ => None,
    }
}

/// Parses a canonical Roman numeral. Anything to_roman would not produce is rejected.
pub fn from_roman(s: &str) -> Result<u32, RomanError> {
    if s.is_empty() {
        return Err(RomanError::Empty);
    }
    let mut values = Vec::new();
    for c in s.chars() {
        match digit_value(c) {
            Some(v) => values.push(v),
            None => return Err(RomanError::InvalidChar(c)),
        }
    }
    if values.len() > MAX_LEN {
        return Err(RomanError::NonCanonical);
    }
    let mut total = 0;
    for (i, &v) in values.iter().enumerate() {
        match values.get(i + 1) {
            Some(&next) if v < next => total -= v as i64,
            _ => total += v as i64,
        }
    }
    let n = u32::try_from(total).map_err(|_| RomanError::NonCanonical)?;
    match to_roman(n) {
        Ok(canonical) if canonical == s => Ok(n),
        _ => Err(RomanError::NonCanonical),
    }
}
