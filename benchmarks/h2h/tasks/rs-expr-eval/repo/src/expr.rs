use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum EvalError {
    /// Byte offset of the first character the parser could not accept.
    Parse {
        pos: usize,
    },
    UnknownVar(String),
    DivByZero,
}

/// Evaluates an expression. So far only integer literals joined by `+` and `-`
/// are supported, evaluated left to right, with spaces between tokens.
pub fn eval(input: &str, _vars: &HashMap<String, f64>) -> Result<f64, EvalError> {
    let bytes = input.as_bytes();
    let mut pos = 0;
    let mut total = 0.0;
    let mut sign = 1.0;
    let mut expect_number = true;
    while pos < bytes.len() {
        let c = bytes[pos];
        if c == b' ' {
            pos += 1;
        } else if expect_number && c.is_ascii_digit() {
            let start = pos;
            while pos < bytes.len() && bytes[pos].is_ascii_digit() {
                pos += 1;
            }
            let n: f64 = input[start..pos].parse().unwrap();
            total += sign * n;
            expect_number = false;
        } else if !expect_number && (c == b'+' || c == b'-') {
            sign = if c == b'+' { 1.0 } else { -1.0 };
            expect_number = true;
            pos += 1;
        } else {
            return Err(EvalError::Parse { pos });
        }
    }
    if expect_number {
        return Err(EvalError::Parse { pos: input.len() });
    }
    Ok(total)
}
