use statkit::stats::{count, mean, percentile};
use statkit::summary;

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn mean_of_values() {
    assert!(close(mean(&[1.0, 2.0, 3.0, 6.0]).unwrap(), 3.0));
    assert_eq!(count(&[1.0, 2.0]), 2);
}

#[test]
fn percentile_extremes_of_sorted_input() {
    let v = [1.0, 2.0, 3.0];
    assert!(close(percentile(&v, 0.0).unwrap(), 1.0));
    assert!(close(percentile(&v, 50.0).unwrap(), 2.0));
    assert!(close(percentile(&v, 100.0).unwrap(), 3.0));
}

#[test]
fn summary_of_single_value() {
    assert_eq!(summary(&[5.0]), "n=1 mean=5.00 p50=5.00 p90=5.00");
}
