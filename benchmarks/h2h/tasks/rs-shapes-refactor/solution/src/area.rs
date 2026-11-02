use crate::shape::Shape;

/// Area of a shape given by kind name and parameters.
///
/// Kinds (ASCII case-insensitive): "circle" [r], "rect" or "rectangle" [w, h],
/// "square" [side], "triangle" [a, b, c].
pub fn area(kind: &str, params: &[f64]) -> Result<f64, String> {
    Shape::parse(kind, params)
        .and_then(|s| s.area())
        .map_err(|e| e.to_string())
}
