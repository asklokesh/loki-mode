use exprkit::{eval, EvalError};
use std::collections::HashMap;

fn run(s: &str) -> Result<f64, EvalError> {
    eval(s, &HashMap::new())
}

fn with(s: &str, vars: &[(&str, f64)]) -> Result<f64, EvalError> {
    let map: HashMap<String, f64> = vars.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    eval(s, &map)
}

fn approx_with(s: &str, vars: &[(&str, f64)], want: f64) {
    match with(s, vars) {
        Ok(got) => assert!((got - want).abs() < 1e-9, "{s}: got {got}, want {want}"),
        Err(e) => panic!("{s}: got error {e:?}, want {want}"),
    }
}

fn approx(s: &str, want: f64) {
    approx_with(s, &[], want);
}

fn parse_err(s: &str, pos: usize) {
    assert_eq!(run(s), Err(EvalError::Parse { pos }), "input {s:?}");
}

fn arity(name: &str, expected: &str, got: usize) -> EvalError {
    EvalError::Arity {
        name: name.to_string(),
        expected: expected.to_string(),
        got,
    }
}

fn unknown_var(name: &str) -> EvalError {
    EvalError::UnknownVar(name.to_string())
}

fn unknown_func(name: &str) -> EvalError {
    EvalError::UnknownFunc(name.to_string())
}

#[test]
fn precedence_and_left_associativity() {
    approx("1 + 2 * 3", 7.0);
    approx("(1 + 2) * 3", 9.0);
    approx("7 - 2 * 3", 1.0);
    approx("100 / 10 / 5", 2.0);
    approx("2 * 6 / 3", 4.0);
    approx("7 % 4 % 2", 1.0);
    approx("1 - 2 + 3", 2.0);
}

#[test]
fn power_and_unary_signs() {
    approx("2^3^2", 512.0);
    approx("(2^3)^2", 64.0);
    approx("2 ^ 0.5", 2f64.sqrt());
    approx("3 * 2 ^ 2", 12.0);
    approx("-2^2", -4.0);
    approx("(-2)^2", 4.0);
    approx("2^-1", 0.5);
    approx("-2^-2", -0.25);
    approx("2^-1^2", 0.5);
    approx("--3", 3.0);
    approx("-+-3", 3.0);
    approx("- - 1", 1.0);
    approx("2*-3", -6.0);
    approx("2--2", 4.0);
    approx("-(1 + 2)", -3.0);
}

fn timed(s: &str) -> Result<f64, EvalError> {
    let start = std::time::Instant::now();
    let result = run(s);
    let elapsed = start.elapsed();
    println!("deep input of {} bytes: {elapsed:?}", s.len());
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "input of {} bytes took {elapsed:?}",
        s.len()
    );
    result
}

fn nested(open: &str, inner: &str, close: &str, depth: usize) -> String {
    format!("{}{inner}{}", open.repeat(depth), close.repeat(depth))
}

#[test]
fn deep_nesting_does_not_overflow() {
    const N: usize = 100_000;
    assert_eq!(timed(&nested("(", "1", ")", N)), Ok(1.0));
    assert_eq!(timed(&nested("abs(", "-3", ")", N)), Ok(3.0));
    assert_eq!(timed(&nested("max(1, ", "5", ")", N)), Ok(5.0));
    assert_eq!(
        timed(&nested("(", "q", ")", N)),
        Err(EvalError::UnknownVar("q".to_string()))
    );
    let unclosed = format!("{}1", "(".repeat(N));
    assert_eq!(timed(&unclosed), Err(EvalError::Parse { pos: N + 1 }));
    let empty_inside = format!("{})", "(".repeat(N));
    assert_eq!(timed(&empty_inside), Err(EvalError::Parse { pos: N }));
}

#[test]
fn long_operator_chains_do_not_overflow() {
    const N: usize = 100_000;
    assert_eq!(timed(&format!("{}2", "-".repeat(N))), Ok(2.0));
    assert_eq!(timed(&format!("{}2", "-".repeat(N - 1))), Ok(-2.0));
    assert_eq!(timed(&format!("{}1", "1^".repeat(N))), Ok(1.0));
    assert_eq!(timed(&format!("2^{}1", "1^".repeat(N))), Ok(2.0));
    assert_eq!(
        timed(&format!("{}1", "1+".repeat(2 * N - 1))),
        Ok(200_000.0)
    );
    assert_eq!(timed(&"(1)".repeat(N)), Ok(1.0));
}

#[test]
fn decimals_modulo_and_whitespace() {
    approx("0.5 + 0.25", 0.75);
    approx("007", 7.0);
    approx("-7 % 3", -1.0);
    approx("7.5 % 2", 1.5);
    approx("\t1\n+\r 2 ", 3.0);
}

#[test]
fn variables_evaluation_order_and_division_by_zero() {
    let vars = [("x", 2.0), ("y", 3.0), ("rate_2", 0.5), ("_tmp", 10.0)];
    approx_with("x * y + 1", &vars, 7.0);
    approx_with("rate_2 * _tmp", &vars, 5.0);
    approx_with("x^y", &vars, 8.0);
    assert_eq!(run("a + 1"), Err(unknown_var("a")));
    assert_eq!(run("1 / 0 + q"), Err(EvalError::DivByZero));
    assert_eq!(run("q + 1 / 0"), Err(unknown_var("q")));
    assert_eq!(run("1 / 0"), Err(EvalError::DivByZero));
    assert_eq!(run("5 % 0"), Err(EvalError::DivByZero));
    assert_eq!(run("1 / (2 - 2)"), Err(EvalError::DivByZero));
    assert_eq!(run("1 / -0"), Err(EvalError::DivByZero));
}

#[test]
fn functions() {
    approx("min(3, 1, 2)", 1.0);
    approx("max(-1)", -1.0);
    approx("max(1 + 2, 2 * 2)", 4.0);
    approx("abs(-2.5)", 2.5);
    approx("abs (-3)", 3.0);
    approx("sqrt(16)", 4.0);
    approx("max(1, min(5, 3))", 3.0);
    approx("-abs(-2)", -2.0);
    approx("sqrt(4)^3", 8.0);
    approx("2^abs(-3)", 8.0);
    approx("sqrt(0)", 0.0);
    approx_with("abs(abs)", &[("abs", -4.0)], 4.0);
}

#[test]
fn function_errors() {
    assert_eq!(run("foo(1)"), Err(unknown_func("foo")));
    assert_eq!(with("x(2)", &[("x", 1.0)]), Err(unknown_func("x")));
    assert_eq!(run("abs(1, 2)"), Err(arity("abs", "1", 2)));
    assert_eq!(run("sqrt()"), Err(arity("sqrt", "1", 0)));
    assert_eq!(run("min()"), Err(arity("min", "at least 1", 0)));
    assert_eq!(run("max()"), Err(arity("max", "at least 1", 0)));
    assert_eq!(run("sqrt(-1)"), Err(EvalError::Domain("sqrt".to_string())));
    assert_eq!(
        run("sqrt(1 - 5)"),
        Err(EvalError::Domain("sqrt".to_string()))
    );
}

#[test]
fn call_error_order() {
    assert_eq!(run("foo(1 / 0)"), Err(unknown_func("foo")));
    assert_eq!(run("abs(1 / 0, q)"), Err(arity("abs", "1", 2)));
    assert_eq!(run("sqrt(q)"), Err(unknown_var("q")));
    assert_eq!(run("min(1, q, 1 / 0)"), Err(unknown_var("q")));
    assert_eq!(
        run("sqrt(-1) + q"),
        Err(EvalError::Domain("sqrt".to_string()))
    );
    assert_eq!(run("q + sqrt(-1)"), Err(unknown_var("q")));
}

#[test]
fn implicit_multiplication() {
    let vars = [("x", 3.0), ("y", 2.0), ("x3", 5.0)];
    approx_with("2x", &vars, 6.0);
    approx_with("2 x", &vars, 6.0);
    approx_with("x y", &vars, 6.0);
    approx_with("2x3", &vars, 10.0);
    approx("2(3 + 4)", 14.0);
    approx("(1 + 2)(3 + 4)", 21.0);
    approx("2(3)(4)", 24.0);
    approx("3abs(-2)", 6.0);
    approx("2sqrt(9)", 6.0);
}

#[test]
fn implicit_multiplication_precedence() {
    let vars = [("x", 3.0)];
    approx_with("2x^2", &vars, 18.0);
    approx_with("-2x", &vars, -6.0);
    approx_with("2^3x", &vars, 24.0);
    approx_with("2^-1x", &vars, 1.5);
    approx("6/2(1 + 2)", 9.0);
    approx("8 % 3(2)", 4.0);
    approx_with("1 + 2x", &vars, 7.0);
    approx_with("x^2(2)", &vars, 18.0);
}

#[test]
fn implicit_multiplication_edge_cases() {
    assert_eq!(with("2x(3)", &[("x", 1.0)]), Err(unknown_func("x")));
    assert_eq!(run("zz zz"), Err(unknown_var("zz")));
    parse_err("(2)3", 3);
    parse_err("x 2", 2);
    parse_err("2 3", 2);
}

#[test]
fn parse_error_at_end_of_input() {
    parse_err("", 0);
    parse_err("   ", 3);
    parse_err("1 +", 3);
    parse_err("(1 + 2", 6);
    parse_err("2 ^", 3);
    parse_err("-", 1);
    parse_err("max(1", 5);
    parse_err("min(1,", 6);
    parse_err("(1 + 2)(3 + 4", 13);
}

#[test]
fn parse_error_at_offending_character() {
    parse_err("1 + 2)", 5);
    parse_err("1 + * 2", 4);
    parse_err("()", 1);
    parse_err("2 * (3 + )", 9);
    parse_err("X + 1", 0);
    parse_err("x + Y", 4);
    parse_err("1 $ 2", 2);
    parse_err("1 + \u{e9}", 4);
    parse_err("1,2", 1);
    parse_err("min(1 2)", 6);
    parse_err("min(,1)", 4);
    parse_err("min(1,)", 6);
    parse_err("sqrt(4))", 7);
}

#[test]
fn malformed_numbers_and_parse_priority() {
    parse_err(".5", 0);
    parse_err("5.", 1);
    parse_err("1 + 3.x", 5);
    parse_err("1.2.3", 3);
    parse_err("q +", 3);
    parse_err("1 / 0 +", 7);
    parse_err("foo(1) +", 8);
    parse_err("sqrt(-1) )", 9);
}
