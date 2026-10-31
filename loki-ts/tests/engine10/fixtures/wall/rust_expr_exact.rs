use calc::{eval, EvalError};
use std::collections::HashMap;

fn vars() -> HashMap<String, f64> {
    let mut m = HashMap::new();
    m.insert("x".to_string(), 3.0);
    m
}

#[test]
fn numbers_and_exponents() {
    // clause: C1
    assert_eq!(eval("3", &vars()), Ok(3.0));
    assert_eq!(eval("3.25", &vars()), Ok(3.25));
    assert_eq!(eval(".5", &vars()), Ok(0.5));
    assert_eq!(eval("5.", &vars()), Ok(5.0));
    assert_eq!(eval("1e3", &vars()), Ok(1000.0));
    assert!((eval("2.5E-2", &vars()).unwrap() - 0.025).abs() < 1e-12);
    // clause: C1 negative
    assert_eq!(eval(".", &vars()), Err(EvalError::Syntax(0)));
}

#[test]
fn identifiers_variables_and_calls() {
    // clause: C2
    assert_eq!(eval("x * 2", &vars()), Ok(6.0));
    assert_eq!(eval("abs(-x)", &vars()), Ok(3.0));
    // clause: C2 negative
    assert_eq!(eval("y", &vars()), Err(EvalError::UnknownVariable("y".to_string())));
}

#[test]
fn precedence_multiplicative_over_additive() {
    // clause: C3
    assert_eq!(eval("1 + 2 * 3", &vars()), Ok(7.0));
    assert_eq!(eval("2 * 3 + 1", &vars()), Ok(7.0));
    // clause: C3 negative
    assert_ne!(eval("1 + 2 * 3", &vars()), Ok(9.0));
}

#[test]
fn additive_left_associative() {
    // clause: C4
    assert_eq!(eval("10 - 3 - 2", &vars()), Ok(5.0));
    assert_eq!(eval("1 + 2 - 3", &vars()), Ok(0.0));
    // clause: C4 negative
    assert_eq!(eval("1 +", &vars()), Err(EvalError::Syntax(3)));
}

#[test]
fn multiplicative_left_associative_and_remainder() {
    // clause: C5
    assert_eq!(eval("8 / 2 / 2", &vars()), Ok(2.0));
    assert_eq!(eval("-7 % 3", &vars()), Ok(-1.0));
    assert_eq!(eval("7 % -3", &vars()), Ok(1.0));
    // clause: C5 negative
    assert_eq!(eval("1 / 0", &vars()), Err(EvalError::DivisionByZero));
}

#[test]
fn unary_plus_minus_repeat() {
    // clause: C6
    assert_eq!(eval("--2", &vars()), Ok(2.0));
    assert_eq!(eval("+-3", &vars()), Ok(-3.0));
    assert_eq!(eval("- + 4", &vars()), Ok(-4.0));
    // clause: C6 negative
    assert_eq!(eval("-", &vars()), Err(EvalError::Syntax(1)));
}

#[test]
fn power_right_associative_and_binds_tighter_than_unary() {
    // clause: C7
    assert_eq!(eval("-2^2", &vars()), Ok(-4.0));
    assert_eq!(eval("2^3^2", &vars()), Ok(512.0));
    assert_eq!(eval("2^-1", &vars()), Ok(0.5));
    assert_eq!(eval("(-2)^2", &vars()), Ok(4.0));
    // clause: C7 negative
    assert_eq!(eval("2^", &vars()), Err(EvalError::Syntax(2)));
}

#[test]
fn parentheses_and_whitespace() {
    // clause: C8
    assert_eq!(eval("(1 + 2) * 3", &vars()), Ok(9.0));
    assert_eq!(eval("\t(1\n+\t2)\n", &vars()), Ok(3.0));
    // clause: C8 negative
    assert_eq!(eval("(1", &vars()), Err(EvalError::Syntax(2)));
}

#[test]
fn builtin_functions() {
    // clause: C9
    assert_eq!(eval("abs(-3)", &vars()), Ok(3.0));
    assert_eq!(eval("sqrt(16)", &vars()), Ok(4.0));
    assert_eq!(eval("min(3, 1, 2)", &vars()), Ok(1.0));
    assert_eq!(eval("max(3, 1, 2)", &vars()), Ok(3.0));
    // clause: C9 negative
    assert_eq!(eval("max()", &vars()), Err(EvalError::Arity("max".to_string())));
}

#[test]
fn syntax_error_offsets() {
    // clause: C10
    assert_eq!(eval("", &vars()), Err(EvalError::Syntax(0)));
    assert_eq!(eval("1 +", &vars()), Err(EvalError::Syntax(3)));
    assert_eq!(eval("1 2", &vars()), Err(EvalError::Syntax(2)));
    assert_eq!(eval("(1", &vars()), Err(EvalError::Syntax(2)));
    assert_eq!(eval("1 $ 2", &vars()), Err(EvalError::Syntax(2)));
    // clause: C10 negative
    assert_eq!(eval("x +", &HashMap::new()), Err(EvalError::Syntax(3)));
}

#[test]
fn unknown_names_are_errors() {
    // clause: C11
    assert_eq!(eval("y", &vars()), Err(EvalError::UnknownVariable("y".to_string())));
    assert_eq!(eval("nope(1)", &vars()), Err(EvalError::UnknownFunction("nope".to_string())));
    // clause: C11 negative
    assert_eq!(eval("x", &vars()), Ok(3.0));
}

#[test]
fn arity_errors_name_the_function() {
    // clause: C12
    assert_eq!(eval("sqrt(1, 2)", &vars()), Err(EvalError::Arity("sqrt".to_string())));
    assert_eq!(eval("abs()", &vars()), Err(EvalError::Arity("abs".to_string())));
    // clause: C12 negative
    assert_eq!(eval("abs(-1)", &vars()), Ok(1.0));
}

#[test]
fn division_and_remainder_by_zero() {
    // clause: C13
    assert_eq!(eval("1 / 0", &vars()), Err(EvalError::DivisionByZero));
    assert_eq!(eval("5 % 0", &vars()), Err(EvalError::DivisionByZero));
    // clause: C13 negative
    assert_eq!(eval("1 / 2", &vars()), Ok(0.5));
}

#[test]
fn sqrt_domain_error() {
    // clause: C14
    assert_eq!(eval("sqrt(-1)", &vars()), Err(EvalError::Domain("sqrt".to_string())));
    // clause: C14 negative
    assert_eq!(eval("sqrt(0)", &vars()), Ok(0.0));
}
