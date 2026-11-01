use exprkit::{eval, EvalError};
use std::collections::HashMap;

fn run(s: &str) -> Result<f64, EvalError> {
    eval(s, &HashMap::new())
}

#[test]
fn adds_and_subtracts_left_to_right() {
    assert_eq!(run("1 + 2"), Ok(3.0));
    assert_eq!(run("10 - 4 - 3"), Ok(3.0));
    assert_eq!(run("42"), Ok(42.0));
}

#[test]
fn reports_parse_errors() {
    assert_eq!(run("1 +"), Err(EvalError::Parse { pos: 3 }));
    assert_eq!(run("1 + * 2"), Err(EvalError::Parse { pos: 4 }));
}
