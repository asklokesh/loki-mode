use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum EvalError {
    /// Byte offset of the first character the parser could not accept.
    Parse {
        pos: usize,
    },
    UnknownVar(String),
    UnknownFunc(String),
    Arity {
        name: String,
        expected: String,
        got: usize,
    },
    Domain(String),
    DivByZero,
}

/// One instruction of the postfix program the parser emits.
enum Op {
    Num(f64),
    Var(String),
    Neg,
    Bin(u8),
    /// Emitted where a call starts, so name and arity are checked before its arguments run.
    Check(String, usize),
    Call(String, usize),
}

/// Entries of the parser's explicit operator stack (no recursion, so nesting depth is unbounded).
enum Item {
    Paren,
    Call {
        name: String,
        check_at: usize,
        argc: usize,
    },
    Neg,
    Bin(u8),
}

fn precedence(item: &Item) -> u8 {
    match item {
        Item::Bin(b'+' | b'-') => 1,
        Item::Bin(b'^') => 4,
        Item::Bin(_) => 2,
        Item::Neg => 3,
        Item::Paren | Item::Call { .. } => 0,
    }
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_lowercase() || c == b'_'
}

fn is_ident_char(c: u8) -> bool {
    is_ident_start(c) || c.is_ascii_digit()
}

struct Parser<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
    out: Vec<Op>,
    stack: Vec<Item>,
}

impl Parser<'_> {
    /// The next non-whitespace byte, without consuming it.
    fn peek(&mut self) -> Option<u8> {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
        self.bytes.get(self.pos).copied()
    }

    fn error(&mut self) -> EvalError {
        self.peek();
        EvalError::Parse { pos: self.pos }
    }

    fn push_binary(&mut self, op: u8) {
        let incoming = precedence(&Item::Bin(op));
        while let Some(top) = self.stack.last() {
            let p = precedence(top);
            if p == 0 || p < incoming || (p == incoming && op == b'^') {
                break;
            }
            let item = self.stack.pop().expect("checked non-empty");
            self.emit(item);
        }
        self.stack.push(Item::Bin(op));
    }

    fn emit(&mut self, item: Item) {
        match item {
            Item::Neg => self.out.push(Op::Neg),
            Item::Bin(op) => self.out.push(Op::Bin(op)),
            Item::Paren | Item::Call { .. } => unreachable!("markers are never emitted"),
        }
    }

    /// Pops operators down to the nearest '(' or call marker and returns that marker.
    fn pop_to_marker(&mut self) -> Option<Item> {
        while let Some(item) = self.stack.pop() {
            match item {
                Item::Paren | Item::Call { .. } => return Some(item),
                _ => self.emit(item),
            }
        }
        None
    }

    fn finish_call(&mut self, name: String, check_at: usize, argc: usize) {
        self.out[check_at] = Op::Check(name.clone(), argc);
        self.out.push(Op::Call(name, argc));
    }

    fn number(&mut self) -> Result<f64, EvalError> {
        let start = self.pos;
        self.digits();
        if self.bytes.get(self.pos) == Some(&b'.') {
            let dot = self.pos;
            self.pos += 1;
            if !self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
                return Err(EvalError::Parse { pos: dot });
            }
            self.digits();
        }
        Ok(self.src[start..self.pos]
            .parse()
            .expect("digits form a valid f64"))
    }

    fn digits(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
    }

    /// Shunting-yard over the grammar in task.txt; returns the postfix program.
    fn parse(mut self) -> Result<Vec<Op>, EvalError> {
        let mut expect_operand = true;
        loop {
            let next = self.peek();
            if expect_operand {
                match next {
                    Some(b'-') => {
                        self.pos += 1;
                        self.stack.push(Item::Neg);
                    }
                    Some(b'+') => self.pos += 1,
                    Some(b'(') => {
                        self.pos += 1;
                        self.stack.push(Item::Paren);
                    }
                    Some(c) if c.is_ascii_digit() => {
                        let n = self.number()?;
                        self.out.push(Op::Num(n));
                        expect_operand = false;
                    }
                    Some(c) if is_ident_start(c) => {
                        let start = self.pos;
                        while self.pos < self.bytes.len() && is_ident_char(self.bytes[self.pos]) {
                            self.pos += 1;
                        }
                        let name = self.src[start..self.pos].to_string();
                        if self.peek() != Some(b'(') {
                            self.out.push(Op::Var(name));
                            expect_operand = false;
                            continue;
                        }
                        self.pos += 1;
                        let check_at = self.out.len();
                        self.out.push(Op::Check(String::new(), 0));
                        if self.peek() == Some(b')') {
                            self.pos += 1;
                            self.finish_call(name, check_at, 0);
                            expect_operand = false;
                        } else {
                            self.stack.push(Item::Call {
                                name,
                                check_at,
                                argc: 0,
                            });
                        }
                    }
                    _ => return Err(self.error()),
                }
                continue;
            }
            match next {
                None => break,
                Some(op @ (b'+' | b'-' | b'*' | b'/' | b'%' | b'^')) => {
                    self.pos += 1;
                    self.push_binary(op);
                    expect_operand = true;
                }
                Some(c) if c == b'(' || is_ident_start(c) => {
                    // Implicit multiplication: same level as '*', operand not consumed yet.
                    self.push_binary(b'*');
                    expect_operand = true;
                }
                Some(b')') => {
                    let at = self.pos;
                    match self.pop_to_marker() {
                        Some(Item::Paren) => {}
                        Some(Item::Call {
                            name,
                            check_at,
                            argc,
                        }) => self.finish_call(name, check_at, argc + 1),
                        _ => return Err(EvalError::Parse { pos: at }),
                    }
                    self.pos += 1;
                }
                Some(b',') => {
                    let at = self.pos;
                    match self.pop_to_marker() {
                        Some(Item::Call {
                            name,
                            check_at,
                            argc,
                        }) => self.stack.push(Item::Call {
                            name,
                            check_at,
                            argc: argc + 1,
                        }),
                        _ => return Err(EvalError::Parse { pos: at }),
                    }
                    self.pos += 1;
                    expect_operand = true;
                }
                _ => return Err(self.error()),
            }
        }
        while let Some(item) = self.stack.pop() {
            match item {
                Item::Paren | Item::Call { .. } => {
                    return Err(EvalError::Parse {
                        pos: self.bytes.len(),
                    })
                }
                _ => self.emit(item),
            }
        }
        Ok(self.out)
    }
}

fn check_call(name: &str, argc: usize) -> Result<(), EvalError> {
    let expected = match name {
        "min" | "max" if argc >= 1 => return Ok(()),
        "abs" | "sqrt" if argc == 1 => return Ok(()),
        "min" | "max" => "at least 1",
        "abs" | "sqrt" => "1",
        _ => return Err(EvalError::UnknownFunc(name.to_string())),
    };
    Err(EvalError::Arity {
        name: name.to_string(),
        expected: expected.to_string(),
        got: argc,
    })
}

fn apply_call(name: &str, args: &[f64]) -> Result<f64, EvalError> {
    match name {
        "min" => Ok(args.iter().copied().fold(f64::INFINITY, f64::min)),
        "max" => Ok(args.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
        "abs" => Ok(args[0].abs()),
        _ if args[0] < 0.0 => Err(EvalError::Domain(name.to_string())),
        _ => Ok(args[0].sqrt()),
    }
}

/// Runs the postfix program. Postfix order is exactly "left operand before right".
fn run(program: &[Op], vars: &HashMap<String, f64>) -> Result<f64, EvalError> {
    let mut values: Vec<f64> = Vec::new();
    for op in program {
        let v = match op {
            Op::Num(n) => *n,
            Op::Var(name) => *vars
                .get(name)
                .ok_or_else(|| EvalError::UnknownVar(name.clone()))?,
            Op::Neg => -values.pop().expect("operand"),
            Op::Check(name, argc) => {
                check_call(name, *argc)?;
                continue;
            }
            Op::Call(name, argc) => {
                let args = values.split_off(values.len() - argc);
                apply_call(name, &args)?
            }
            Op::Bin(op) => {
                let b = values.pop().expect("right operand");
                let a = values.pop().expect("left operand");
                match op {
                    b'+' => a + b,
                    b'-' => a - b,
                    b'*' => a * b,
                    b'/' | b'%' if b == 0.0 => return Err(EvalError::DivByZero),
                    b'/' => a / b,
                    b'%' => a % b,
                    _ => a.powf(b),
                }
            }
        };
        values.push(v);
    }
    Ok(values.pop().expect("one result"))
}

/// Evaluates an arithmetic expression with + - * / % ^, parentheses, unary signs,
/// implicit multiplication, variables and the functions min, max, abs and sqrt.
/// The whole input is parsed before anything is evaluated, without recursion.
pub fn eval(input: &str, vars: &HashMap<String, f64>) -> Result<f64, EvalError> {
    let parser = Parser {
        src: input,
        bytes: input.as_bytes(),
        pos: 0,
        out: Vec::new(),
        stack: Vec::new(),
    };
    let program = parser.parse()?;
    run(&program, vars)
}
