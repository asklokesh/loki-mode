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

/// Converts a number to a Roman numeral.
pub fn to_roman(n: u32) -> Result<String, RomanError> {
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
    match c.to_ascii_uppercase() {
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

/// Parses a Roman numeral.
pub fn from_roman(s: &str) -> Result<u32, RomanError> {
    let mut values = Vec::new();
    for c in s.chars() {
        match digit_value(c) {
            Some(v) => values.push(v),
            None => return Err(RomanError::InvalidChar(c)),
        }
    }
    let mut total = 0;
    let mut i = 0;
    while i < values.len() {
        if i + 2 < values.len() && values[i] < values[i + 1] {
            total += values[i + 1] - values[i];
            i += 2;
        } else {
            total += values[i];
            i += 1;
        }
    }
    Ok(total)
}
