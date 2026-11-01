use shapekit::{area, perimeter};
use std::f64::consts::PI;

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn areas() {
    assert!(close(area("circle", &[2.0]).unwrap(), 4.0 * PI));
    assert!(close(area("rect", &[3.0, 4.0]).unwrap(), 12.0));
    assert!(close(area("Square", &[3.0]).unwrap(), 9.0));
    assert!(close(area("triangle", &[3.0, 4.0, 5.0]).unwrap(), 6.0));
}

#[test]
fn perimeters() {
    assert!(close(perimeter("circle", &[1.0]).unwrap(), 2.0 * PI));
    assert!(close(perimeter("RECTANGLE", &[3.0, 4.0]).unwrap(), 14.0));
    assert!(close(perimeter("square", &[2.5]).unwrap(), 10.0));
    assert!(close(
        perimeter("triangle", &[3.0, 4.0, 5.0]).unwrap(),
        12.0
    ));
}

#[test]
fn error_messages() {
    assert_eq!(
        area("hexagon", &[1.0]),
        Err("unknown shape kind: hexagon".to_string())
    );
    assert_eq!(
        perimeter("rect", &[1.0]),
        Err("expected 2 params, got 1".to_string())
    );
    assert_eq!(
        area("circle", &[-1.0]),
        Err("dimensions must be non-negative".to_string())
    );
    assert_eq!(
        perimeter("triangle", &[1.0, 1.0, 5.0]),
        Err("sides do not form a triangle".to_string())
    );
}
