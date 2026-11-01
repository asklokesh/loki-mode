use std::f64::consts::PI;

/// Perimeter of a shape given by kind name and parameters.
///
/// Kinds (ASCII case-insensitive): "circle" [r], "rect" or "rectangle" [w, h],
/// "square" [side], "triangle" [a, b, c].
pub fn perimeter(kind: &str, params: &[f64]) -> Result<f64, String> {
    let lower = kind.to_ascii_lowercase();
    let expected = match lower.as_str() {
        "circle" | "square" => 1,
        "rect" | "rectangle" => 2,
        "triangle" => 3,
        _ => return Err(format!("unknown shape kind: {kind}")),
    };
    if params.len() != expected {
        return Err(format!("expected {expected} params, got {}", params.len()));
    }
    if params.iter().any(|&p| p < 0.0) {
        return Err("dimensions must be non-negative".to_string());
    }
    match lower.as_str() {
        "circle" => Ok(2.0 * PI * params[0]),
        "square" => Ok(4.0 * params[0]),
        "rect" | "rectangle" => Ok(2.0 * (params[0] + params[1])),
        _ => {
            let (a, b, c) = (params[0], params[1], params[2]);
            if a > b + c || b > a + c || c > a + b {
                return Err("sides do not form a triangle".to_string());
            }
            Ok(a + b + c)
        }
    }
}
