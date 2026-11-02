use std::f64::consts::PI;

/// Area of a shape given by kind name and parameters.
///
/// Kinds (ASCII case-insensitive): "circle" [r], "rect" or "rectangle" [w, h],
/// "square" [side], "triangle" [a, b, c].
pub fn area(kind: &str, params: &[f64]) -> Result<f64, String> {
    match kind.to_ascii_lowercase().as_str() {
        "circle" => {
            if params.len() != 1 {
                return Err(format!("expected 1 params, got {}", params.len()));
            }
            if params[0] < 0.0 {
                return Err("dimensions must be non-negative".to_string());
            }
            Ok(PI * params[0] * params[0])
        }
        "rect" | "rectangle" => {
            if params.len() != 2 {
                return Err(format!("expected 2 params, got {}", params.len()));
            }
            if params[0] < 0.0 || params[1] < 0.0 {
                return Err("dimensions must be non-negative".to_string());
            }
            Ok(params[0] * params[1])
        }
        "square" => {
            if params.len() != 1 {
                return Err(format!("expected 1 params, got {}", params.len()));
            }
            if params[0] < 0.0 {
                return Err("dimensions must be non-negative".to_string());
            }
            Ok(params[0] * params[0])
        }
        "triangle" => {
            if params.len() != 3 {
                return Err(format!("expected 3 params, got {}", params.len()));
            }
            let (a, b, c) = (params[0], params[1], params[2]);
            if a < 0.0 || b < 0.0 || c < 0.0 {
                return Err("dimensions must be non-negative".to_string());
            }
            // Degenerate triangles (a + b == c) are allowed and have area 0.
            if a > b + c || b > a + c || c > a + b {
                return Err("sides do not form a triangle".to_string());
            }
            let s = (a + b + c) / 2.0;
            Ok((s * (s - a) * (s - b) * (s - c)).max(0.0).sqrt())
        }
        _ => Err(format!("unknown shape kind: {kind}")),
    }
}
