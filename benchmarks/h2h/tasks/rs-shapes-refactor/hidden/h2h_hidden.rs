use shapekit::{area, perimeter, Shape, ShapeError};
use std::f64::consts::PI;

fn close(a: Result<f64, ShapeError>, b: f64) -> bool {
    matches!(a, Ok(x) if (x - b).abs() < 1e-9)
}

#[test]
fn parse_builds_each_variant() {
    assert_eq!(Shape::parse("circle", &[2.0]), Ok(Shape::Circle { r: 2.0 }));
    assert_eq!(
        Shape::parse("Rectangle", &[3.0, 4.0]),
        Ok(Shape::Rect { w: 3.0, h: 4.0 })
    );
    assert_eq!(
        Shape::parse("RECT", &[3.0, 4.0]),
        Ok(Shape::Rect { w: 3.0, h: 4.0 })
    );
    assert_eq!(
        Shape::parse("triangle", &[3.0, 4.0, 5.0]),
        Ok(Shape::Triangle {
            a: 3.0,
            b: 4.0,
            c: 5.0
        })
    );
}

#[test]
fn square_parses_to_rect() {
    assert_eq!(
        Shape::parse("SQUARE", &[2.5]),
        Ok(Shape::Rect { w: 2.5, h: 2.5 })
    );
}

#[test]
fn parse_errors_and_their_order() {
    assert_eq!(
        Shape::parse("Hexagon", &[]),
        Err(ShapeError::UnknownKind("Hexagon".to_string()))
    );
    assert_eq!(
        Shape::parse("rect", &[-1.0]),
        Err(ShapeError::WrongParamCount {
            expected: 2,
            got: 1
        })
    );
    assert_eq!(
        Shape::parse("triangle", &[-1.0, 1.0, 9.0]),
        Err(ShapeError::NegativeDimension)
    );
    assert_eq!(
        Shape::parse("triangle", &[1.0, 1.0, 3.0]),
        Err(ShapeError::InvalidTriangle)
    );
}

#[test]
fn display_matches_legacy_messages() {
    assert_eq!(
        ShapeError::UnknownKind("Blob".to_string()).to_string(),
        "unknown shape kind: Blob"
    );
    assert_eq!(
        ShapeError::WrongParamCount {
            expected: 3,
            got: 0
        }
        .to_string(),
        "expected 3 params, got 0"
    );
    assert_eq!(
        ShapeError::NegativeDimension.to_string(),
        "dimensions must be non-negative"
    );
    assert_eq!(
        ShapeError::InvalidTriangle.to_string(),
        "sides do not form a triangle"
    );
}

#[test]
fn methods_compute_area_and_perimeter() {
    assert!(close(Shape::Circle { r: 1.5 }.area(), PI * 2.25));
    assert!(close(Shape::Circle { r: 1.5 }.perimeter(), 3.0 * PI));
    assert!(close(Shape::Rect { w: 2.0, h: 5.0 }.area(), 10.0));
    assert!(close(Shape::Rect { w: 2.0, h: 5.0 }.perimeter(), 14.0));
    let t = Shape::Triangle {
        a: 5.0,
        b: 5.0,
        c: 6.0,
    };
    assert!(close(t.area(), 12.0));
    assert!(close(t.perimeter(), 16.0));
}

#[test]
fn methods_validate_directly_built_shapes() {
    assert_eq!(
        Shape::Circle { r: -1.0 }.area(),
        Err(ShapeError::NegativeDimension)
    );
    assert_eq!(
        Shape::Rect { w: 1.0, h: -2.0 }.perimeter(),
        Err(ShapeError::NegativeDimension)
    );
    let bad = Shape::Triangle {
        a: 1.0,
        b: 2.0,
        c: 4.0,
    };
    assert_eq!(bad.area(), Err(ShapeError::InvalidTriangle));
    assert_eq!(bad.perimeter(), Err(ShapeError::InvalidTriangle));
    let neg = Shape::Triangle {
        a: -1.0,
        b: 2.0,
        c: 9.0,
    };
    assert_eq!(neg.area(), Err(ShapeError::NegativeDimension));
}

#[test]
fn degenerate_and_zero_shapes_are_valid() {
    let flat = Shape::parse("triangle", &[1.0, 2.0, 3.0]).unwrap();
    assert!(close(flat.area(), 0.0));
    assert!(close(flat.perimeter(), 6.0));
    assert!(close(Shape::parse("circle", &[0.0]).unwrap().area(), 0.0));
    assert_eq!(area("triangle", &[1.0, 2.0, 3.0]), Ok(0.0));
}

#[test]
fn legacy_functions_unchanged() {
    assert_eq!(area("square", &[3.0]), Ok(9.0));
    assert_eq!(perimeter("Square", &[3.0]), Ok(12.0));
    assert_eq!(
        area("Blob", &[1.0]),
        Err("unknown shape kind: Blob".to_string())
    );
    assert_eq!(
        perimeter("blob", &[]),
        Err("unknown shape kind: blob".to_string())
    );
    assert_eq!(
        area("circle", &[]),
        Err("expected 1 params, got 0".to_string())
    );
    assert_eq!(
        perimeter("triangle", &[1.0, -2.0]),
        Err("expected 3 params, got 2".to_string())
    );
    assert_eq!(
        perimeter("rect", &[1.0, -2.0]),
        Err("dimensions must be non-negative".to_string())
    );
    assert_eq!(
        area("triangle", &[1.0, 1.0, 5.0]),
        Err("sides do not form a triangle".to_string())
    );
}

#[test]
fn module_path_is_public() {
    let s: shapekit::shape::Shape = shapekit::shape::Shape::parse("circle", &[1.0]).unwrap();
    assert!(matches!(s, Shape::Circle { .. }));
}
