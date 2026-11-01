use crate::shape::Shape;

/// Perimeter of a shape given by kind name and parameters.
///
/// Kinds (ASCII case-insensitive): "circle" [r], "rect" or "rectangle" [w, h],
/// "square" [side], "triangle" [a, b, c].
pub fn perimeter(kind: &str, params: &[f64]) -> Result<f64, String> {
    Shape::parse(kind, params)
        .and_then(|s| s.perimeter())
        .map_err(|e| e.to_string())
}
