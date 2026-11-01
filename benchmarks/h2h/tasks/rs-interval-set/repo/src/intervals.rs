/// One endpoint of an interval: included (Closed) or excluded (Open).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    Closed(i64),
    Open(i64),
}

impl Bound {
    pub fn value(self) -> i64 {
        match self {
            Bound::Closed(v) | Bound::Open(v) => v,
        }
    }

    pub fn is_closed(self) -> bool {
        matches!(self, Bound::Closed(_))
    }
}

/// A set of real numbers made of intervals with integer endpoints.
///
/// First draft: intervals are kept exactly as inserted, so overlapping or
/// touching intervals are not merged yet.
#[derive(Debug, Clone, Default)]
pub struct IntervalSet {
    ranges: Vec<(Bound, Bound)>,
}

impl IntervalSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds the interval from lo to hi. Empty intervals are ignored.
    pub fn insert(&mut self, lo: Bound, hi: Bound) {
        let non_empty = lo.value() < hi.value()
            || (lo.value() == hi.value() && lo.is_closed() && hi.is_closed());
        if non_empty {
            self.ranges.push((lo, hi));
        }
    }

    /// Whether the real number x lies in any stored interval.
    pub fn contains(&self, x: f64) -> bool {
        self.ranges.iter().any(|&(lo, hi)| {
            let above = match lo {
                Bound::Closed(v) => x >= v as f64,
                Bound::Open(v) => x > v as f64,
            };
            let below = match hi {
                Bound::Closed(v) => x <= v as f64,
                Bound::Open(v) => x < v as f64,
            };
            above && below
        })
    }

    /// The stored intervals, sorted by where they start.
    pub fn ranges(&self) -> Vec<(Bound, Bound)> {
        let mut out = self.ranges.clone();
        out.sort_by_key(|&(lo, _)| (lo.value(), !lo.is_closed()));
        out
    }
}
