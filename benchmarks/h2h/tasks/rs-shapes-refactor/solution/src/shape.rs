use std::f64::consts::PI;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Shape {
    Circle { r: f64 },
    Rect { w: f64, h: f64 },
    Triangle { a: f64, b: f64, c: f64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShapeError {
    UnknownKind(String),
    WrongParamCount { expected: usize, got: usize },
    NegativeDimension,
    InvalidTriangle,
}

impl fmt::Display for ShapeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShapeError::UnknownKind(kind) => write!(f, "unknown shape kind: {kind}"),
            ShapeError::WrongParamCount { expected, got } => {
                write!(f, "expected {expected} params, got {got}")
            }
            ShapeError::NegativeDimension => write!(f, "dimensions must be non-negative"),
            ShapeError::InvalidTriangle => write!(f, "sides do not form a triangle"),
        }
    }
}

impl std::error::Error for ShapeError {}

impl Shape {
    /// Builds a shape from a kind name (ASCII case-insensitive) and its parameters.
    pub fn parse(kind: &str, params: &[f64]) -> Result<Shape, ShapeError> {
        let lower = kind.to_ascii_lowercase();
        let expected = match lower.as_str() {
            "circle" | "square" => 1,
            "rect" | "rectangle" => 2,
            "triangle" => 3,
            _ => return Err(ShapeError::UnknownKind(kind.to_string())),
        };
        if params.len() != expected {
            return Err(ShapeError::WrongParamCount {
                expected,
                got: params.len(),
            });
        }
        let shape = match lower.as_str() {
            "circle" => Shape::Circle { r: params[0] },
            "square" => Shape::Rect {
                w: params[0],
                h: params[0],
            },
            "triangle" => Shape::Triangle {
                a: params[0],
                b: params[1],
                c: params[2],
            },
            _ => Shape::Rect {
                w: params[0],
                h: params[1],
            },
        };
        shape.validate()?;
        Ok(shape)
    }

    pub fn area(&self) -> Result<f64, ShapeError> {
        self.validate()?;
        Ok(match *self {
            Shape::Circle { r } => PI * r * r,
            Shape::Rect { w, h } => w * h,
            Shape::Triangle { a, b, c } => {
                let s = (a + b + c) / 2.0;
                (s * (s - a) * (s - b) * (s - c)).max(0.0).sqrt()
            }
        })
    }

    pub fn perimeter(&self) -> Result<f64, ShapeError> {
        self.validate()?;
        Ok(match *self {
            Shape::Circle { r } => 2.0 * PI * r,
            Shape::Rect { w, h } => 2.0 * (w + h),
            Shape::Triangle { a, b, c } => a + b + c,
        })
    }

    /// Zero dimensions and degenerate triangles (one side equal to the sum of the others) are valid.
    fn validate(&self) -> Result<(), ShapeError> {
        let dims: &[f64] = match self {
            Shape::Circle { r } => &[*r],
            Shape::Rect { w, h } => &[*w, *h],
            Shape::Triangle { a, b, c } => &[*a, *b, *c],
        };
        if dims.iter().any(|&d| d < 0.0) {
            return Err(ShapeError::NegativeDimension);
        }
        if let Shape::Triangle { a, b, c } = *self {
            if a > b + c || b > a + c || c > a + b {
                return Err(ShapeError::InvalidTriangle);
            }
        }
        Ok(())
    }
}
