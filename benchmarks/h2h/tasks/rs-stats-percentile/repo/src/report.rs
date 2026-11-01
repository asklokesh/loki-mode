use crate::stats;

/// One-line summary such as "n=4 mean=2.50 p50=2.50 p90=3.70".
/// When the statistics are undefined the line is just the count, e.g. "n=0".
pub fn summary(values: &[f64]) -> String {
    let n = stats::count(values);
    match (
        stats::mean(values),
        stats::median(values),
        stats::percentile(values, 90.0),
    ) {
        (Some(mean), Some(p50), Some(p90)) => {
            format!("n={n} mean={mean:.2} p50={p50:.2} p90={p90:.2}")
        }
        _ => format!("n={n}"),
    }
}
