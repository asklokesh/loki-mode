/// The non-NaN values, sorted ascending, as a new vector.
fn sorted_finite(values: &[f64]) -> Vec<f64> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| !x.is_nan()).collect();
    v.sort_by(f64::total_cmp);
    v
}

/// Number of values that take part in the statistics (NaN values are ignored).
pub fn count(values: &[f64]) -> usize {
    values.iter().filter(|x| !x.is_nan()).count()
}

/// Arithmetic mean of the non-NaN values; None when there are none.
pub fn mean(values: &[f64]) -> Option<f64> {
    let n = count(values);
    if n == 0 {
        return None;
    }
    let sum: f64 = values.iter().filter(|x| !x.is_nan()).sum();
    Some(sum / n as f64)
}

/// The 50th percentile.
pub fn median(values: &[f64]) -> Option<f64> {
    percentile(values, 50.0)
}

/// The p-th percentile, p in [0, 100], by linear interpolation between closest ranks.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if !(0.0..=100.0).contains(&p) {
        return None;
    }
    let v = sorted_finite(values);
    if v.is_empty() {
        return None;
    }
    let rank = p / 100.0 * (v.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    Some(v[lo] + (v[hi] - v[lo]) * (rank - lo as f64))
}
