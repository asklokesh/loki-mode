/// Number of values that take part in the statistics.
pub fn count(values: &[f64]) -> usize {
    values.len()
}

/// Arithmetic mean.
pub fn mean(values: &[f64]) -> Option<f64> {
    let sum: f64 = values.iter().sum();
    Some(sum / values.len() as f64)
}

/// The 50th percentile.
pub fn median(values: &[f64]) -> Option<f64> {
    percentile(values, 50.0)
}

/// The p-th percentile, p in [0, 100].
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return Some(0.0);
    }
    let idx = (p / 100.0 * (values.len() - 1) as f64) as usize;
    Some(values[idx])
}
