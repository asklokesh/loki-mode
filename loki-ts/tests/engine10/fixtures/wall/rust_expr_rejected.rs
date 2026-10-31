use calc::{eval, EvalError};
use std::collections::HashMap;

fn none() -> HashMap<String, f64> {
    HashMap::new()
}

fn vars(pairs: &[(&str, f64)]) -> HashMap<String, f64> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

#[test]
fn c1_numbers() {
    // clause: C1
    assert_eq!(eval("3", &none()), Ok(3.0));
    assert_eq!(eval("3.25", &none()), Ok(3.25));
    assert_eq!(eval(".5", &none()), Ok(0.5));
    assert_eq!(eval("5.", &none()), Ok(5.0));
    assert_eq!(eval("1e3", &none()), Ok(1000.0));
    assert!((eval("2.5E-2", &none()).unwrap() - 0.025).abs() < 1e-12);
    // negative: malformed numbers are rejected
    assert!(eval("1.2.3", &none()).is_err());
    assert!(eval("1e", &none()).is_err());
}

#[test]
fn c2_identifiers() {
    // clause: C2
    let v = vars(&[("x", 2.0), ("_a1", 4.0)]);
    assert_eq!(eval("x", &v), Ok(2.0));
    assert_eq!(eval("_a1 + 1", &v), Ok(5.0));
    assert_eq!(eval("abs(-3)", &none()), Ok(3.0));
    // negative: unknown identifiers are rejected
    assert_eq!(eval("y", &none()), Err(EvalError::UnknownVariable("y".to_string())));
}

#[test]
fn c3_precedence_order() {
    // clause: C3
    assert_eq!(eval("2+3*4^2", &none()), Ok(50.0));
    // negative: multiplication must bind tighter than addition
    assert_ne!(eval("2+3*4", &none()), Ok(20.0));
}

#[test]
fn c4_additive_left_assoc() {
    // clause: C4
    assert_eq!(eval("10-4-3", &none()), Ok(3.0));
    assert_eq!(eval("1+2-3", &none()), Ok(0.0));
    // negative: right associativity would give 9; dangling operator is a syntax error
    assert_ne!(eval("10-4-3", &none()), Ok(9.0));
    assert_eq!(eval("1 -", &none()), Err(EvalError::Syntax(3)));
}

#[test]
fn c5_multiplicative_and_remainder() {
    // clause: C5
    assert_eq!(eval("8/4/2", &none()), Ok(1.0));
    assert_eq!(eval("8/2*3", &none()), Ok(12.0));
    assert_eq!(eval("7%3", &none()), Ok(1.0));
    assert_eq!(eval("-7%3", &none()), Ok(-1.0));
    assert_eq!(eval("7%-3", &none()), Ok(1.0));
    // negative: division is left associative, not right associative (would give 4)
    assert_ne!(eval("8/4/2", &none()), Ok(4.0));
}

#[test]
fn c6_unary_prefix() {
    // clause: C6
    assert_eq!(eval("--2", &none()), Ok(2.0));
    assert_eq!(eval("-+-3", &none()), Ok(3.0));
    assert_eq!(eval("+5", &none()), Ok(5.0));
    // negative: a lone unary operator with no operand is a syntax error at end of input
    assert_eq!(eval("-", &none()), Err(EvalError::Syntax(1)));
}

#[test]
fn c7_power() {
    // clause: C7
    assert_eq!(eval("-2^2", &none()), Ok(-4.0));
    assert_eq!(eval("2^3^2", &none()), Ok(512.0));
    assert_eq!(eval("2^-1", &none()), Ok(0.5));
    // negative: power must not bind looser than unary minus, nor be left associative (64)
    assert_ne!(eval("-2^2", &none()), Ok(4.0));
    assert_ne!(eval("2^3^2", &none()), Ok(64.0));
}

#[test]
fn c8_parentheses_and_whitespace() {
    // clause: C8
    assert_eq!(eval("(1+2)*3", &none()), Ok(9.0));
    assert_eq!(eval(" ( 1 ) ", &none()), Ok(1.0));
    assert_eq!(eval("1\t+\n2", &none()), Ok(3.0));
    // negative: unclosed parenthesis reports end of input
    assert_eq!(eval("(1+2", &none()), Err(EvalError::Syntax(4)));
}

#[test]
fn c9_functions() {
    // clause: C9
    assert_eq!(eval("abs(-3)", &none()), Ok(3.0));
    assert_eq!(eval("sqrt(16)", &none()), Ok(4.0));
    assert_eq!(eval("min(3,1,2)", &none()), Ok(1.0));
    assert_eq!(eval("max(3,1,2)", &none()), Ok(3.0));
    assert_eq!(eval("max(5)", &none()), Ok(5.0));
    // negative: zero-argument max is rejected
    assert!(eval("max()", &none()).is_err());
}

#[test]
fn c10_syntax_errors_and_offsets() {
    // clause: C10
    assert_eq!(eval("", &none()), Err(EvalError::Syntax(0)));
    assert_eq!(eval("1 +", &none()), Err(EvalError::Syntax(3)));
    assert_eq!(eval("1 2", &none()), Err(EvalError::Syntax(2)));
    assert_eq!(eval("(1", &none()), Err(EvalError::Syntax(2)));
    assert_eq!(eval("1 $ 2", &none()), Err(EvalError::Syntax(2)));
    // negative: syntax is checked before evaluation, so unknown x does not win
    assert_eq!(eval("x +", &none()), Err(EvalError::Syntax(3)));
}

#[test]
fn c11_unknown_names() {
    // clause: C11
    assert_eq!(eval("y", &none()), Err(EvalError::UnknownVariable("y".to_string())));
    assert_eq!(eval("foo(1)", &none()), Err(EvalError::UnknownFunction("foo".to_string())));
    // negative: a known variable must not be reported as unknown
    assert_eq!(eval("zz", &vars(&[("zz", 0.0)])), Ok(0.0));
}

#[test]
fn c12_arity() {
    // clause: C12
    assert_eq!(eval("abs(1,2)", &none()), Err(EvalError::Arity("abs".to_string())));
    assert_eq!(eval("sqrt(1,2)", &none()), Err(EvalError::Arity("sqrt".to_string())));
    // negative: correct argument count is accepted
    assert_eq!(eval("abs(-1)", &none()), Ok(1.0));
}

#[test]
fn c13_division_by_zero() {
    // clause: C13
    assert_eq!(eval("1/0", &none()), Err(EvalError::DivisionByZero));
    assert_eq!(eval("1%0", &none()), Err(EvalError::DivisionByZero));
    // negative: non-zero divisor is fine
    assert_eq!(eval("1/0.5", &none()), Ok(2.0));
}

#[test]
fn c14_domain() {
    // clause: C14
    assert_eq!(eval("sqrt(-1)", &none()), Err(EvalError::Domain("sqrt".to_string())));
    // negative: sqrt of a non-negative number succeeds
    assert_eq!(eval("sqrt(4)", &none()), Ok(2.0));
}
