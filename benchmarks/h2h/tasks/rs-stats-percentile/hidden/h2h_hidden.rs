use statkit::stats::{count, mean, median, percentile};
use statkit::summary;

fn close(a: Option<f64>, b: f64) -> bool {
    matches!(a, Some(x) if (x - b).abs() < 1e-9)
}

#[test]
fn even_length_report() {
    assert_eq!(
        summary(&[1.0, 2.0, 3.0, 4.0]),
        "n=4 mean=2.50 p50=2.50 p90=3.70"
    );
}

#[test]
fn report_ignores_input_order() {
    assert_eq!(
        summary(&[4.0, 1.0, 3.0, 2.0]),
        "n=4 mean=2.50 p50=2.50 p90=3.70"
    );
    assert_eq!(
        summary(&[10.0, 0.0, 5.0]),
        "n=3 mean=5.00 p50=5.00 p90=9.00"
    );
}

#[test]
fn empty_report_is_just_the_count() {
    assert_eq!(summary(&[]), "n=0");
    assert_eq!(summary(&[f64::NAN, f64::NAN]), "n=0");
}

#[test]
fn nan_values_are_ignored_in_the_report() {
    assert_eq!(
        summary(&[f64::NAN, 3.0, 1.0, f64::NAN, 2.0]),
        "n=3 mean=2.00 p50=2.00 p90=2.80"
    );
}

#[test]
fn percentile_interpolates_linearly() {
    let v = [15.0, 20.0, 35.0, 40.0, 50.0];
    assert!(close(percentile(&v, 40.0), 29.0));
    assert!(close(percentile(&v, 30.0), 23.0));
    assert!(close(percentile(&v, 100.0), 50.0));
    assert!(close(percentile(&v, 0.0), 15.0));
    assert!(close(percentile(&[7.0, 1.0], 25.0), 2.5));
}

#[test]
fn percentile_sorts_a_copy() {
    let v = vec![9.0, 1.0, 5.0, 3.0];
    assert!(close(percentile(&v, 0.0), 1.0));
    assert!(close(percentile(&v, 100.0), 9.0));
    assert!(close(median(&v), 4.0));
    assert_eq!(v, vec![9.0, 1.0, 5.0, 3.0]);
}

#[test]
fn empty_input_is_none() {
    assert_eq!(mean(&[]), None);
    assert_eq!(median(&[]), None);
    assert_eq!(percentile(&[], 50.0), None);
    assert_eq!(count(&[]), 0);
}

#[test]
fn p_outside_range_is_none() {
    let v = [1.0, 2.0, 3.0];
    assert_eq!(percentile(&v, -0.1), None);
    assert_eq!(percentile(&v, 100.5), None);
    assert_eq!(percentile(&v, f64::NAN), None);
}

#[test]
fn nan_values_are_skipped_by_every_function() {
    let v = [f64::NAN, 4.0, f64::NAN, 2.0];
    assert_eq!(count(&v), 2);
    assert!(close(mean(&v), 3.0));
    assert!(close(median(&v), 3.0));
    assert!(close(percentile(&v, 100.0), 4.0));
    assert_eq!(mean(&[f64::NAN]), None);
    assert_eq!(percentile(&[f64::NAN], 10.0), None);
}

#[test]
fn single_value_and_odd_median() {
    assert!(close(percentile(&[42.0], 73.0), 42.0));
    assert!(close(median(&[3.0, 1.0, 2.0]), 2.0));
}
