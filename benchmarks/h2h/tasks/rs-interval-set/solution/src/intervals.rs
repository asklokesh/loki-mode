use std::collections::BTreeMap;
use std::fmt;

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

    /// The same point with the opposite inclusion.
    fn flip(self) -> Bound {
        match self {
            Bound::Closed(v) => Bound::Open(v),
            Bound::Open(v) => Bound::Closed(v),
        }
    }

    /// Ordering key for a lower bound: [v starts before (v.
    fn lower_key(self) -> (i64, bool) {
        (self.value(), !self.is_closed())
    }

    /// Ordering key for an upper bound: v) ends before v].
    fn upper_key(self) -> (i64, bool) {
        (self.value(), self.is_closed())
    }
}

type Interval = (Bound, Bound);

fn non_empty((lo, hi): Interval) -> bool {
    lo.value() < hi.value() || (lo.value() == hi.value() && lo.is_closed() && hi.is_closed())
}

/// Whether an interval ending at `hi` and one starting at `lo` (not before the
/// first one's start) form a single interval together.
fn connects(hi: Bound, lo: Bound) -> bool {
    lo.value() < hi.value() || (lo.value() == hi.value() && (lo.is_closed() || hi.is_closed()))
}

fn max_lower(a: Bound, b: Bound) -> Bound {
    if a.lower_key() >= b.lower_key() {
        a
    } else {
        b
    }
}

fn min_upper(a: Bound, b: Bound) -> Bound {
    if a.upper_key() <= b.upper_key() {
        a
    } else {
        b
    }
}

fn intersects((l, h): Interval, (a, b): Interval) -> bool {
    non_empty((max_lower(l, a), min_upper(h, b)))
}

/// A set of real numbers made of intervals with integer endpoints.
///
/// Invariant: `map` holds the canonical intervals (non-empty, pairwise
/// non-connecting) keyed by their lower bound's ordering key.
#[derive(Debug, Clone, Default)]
pub struct IntervalSet {
    map: BTreeMap<(i64, bool), Interval>,
}

impl IntervalSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds the interval from lo to hi. Empty intervals are ignored.
    /// Amortized O(log n): every interval it absorbs was inserted earlier.
    pub fn insert(&mut self, lo: Bound, hi: Bound) {
        if !non_empty((lo, hi)) {
            return;
        }
        let (mut lo, mut hi) = (lo, hi);
        let before = self.map.range(..=lo.lower_key()).next_back();
        if let Some((&key, &(pl, ph))) = before {
            if connects(ph, lo) {
                self.map.remove(&key);
                lo = pl;
                hi = if ph.upper_key() > hi.upper_key() {
                    ph
                } else {
                    hi
                };
            }
        }
        loop {
            let after = self.map.range(lo.lower_key()..).next();
            match after {
                Some((&key, &(nl, nh))) if connects(hi, nl) => {
                    self.map.remove(&key);
                    hi = if nh.upper_key() > hi.upper_key() {
                        nh
                    } else {
                        hi
                    };
                }
                _ => break,
            }
        }
        self.map.insert(lo.lower_key(), (lo, hi));
    }

    /// Removes the interval from lo to hi. Empty intervals are ignored.
    /// Amortized O(log n): at most two pieces are added back per call.
    pub fn remove(&mut self, lo: Bound, hi: Bound) {
        let cut = (lo, hi);
        if !non_empty(cut) {
            return;
        }
        let mut hits = Vec::new();
        if let Some((&key, &iv)) = self.map.range(..lo.lower_key()).next_back() {
            if intersects(iv, cut) {
                hits.push((key, iv));
            }
        }
        for (&key, &iv) in self.map.range(lo.lower_key()..) {
            if !intersects(iv, cut) {
                break;
            }
            hits.push((key, iv));
        }
        for (key, (l, h)) in hits {
            self.map.remove(&key);
            let left = (l, min_upper(h, lo.flip()));
            if non_empty(left) {
                self.map.insert(l.lower_key(), left);
            }
            let right = (max_lower(l, hi.flip()), h);
            if non_empty(right) {
                self.map.insert(right.0.lower_key(), right);
            }
        }
    }

    /// Whether the real number x lies in the set. O(log n).
    pub fn contains(&self, x: f64) -> bool {
        if x.is_nan() {
            return false;
        }
        // Only the last interval starting at or below floor(x) can contain x.
        let key = (x.floor() as i64, true);
        let Some((_, &(lo, hi))) = self.map.range(..=key).next_back() else {
            return false;
        };
        let above = match lo {
            Bound::Closed(v) => x >= v as f64,
            Bound::Open(v) => x > v as f64,
        };
        let below = match hi {
            Bound::Closed(v) => x <= v as f64,
            Bound::Open(v) => x < v as f64,
        };
        above && below
    }

    /// The set in canonical form.
    pub fn ranges(&self) -> Vec<(Bound, Bound)> {
        self.map.values().copied().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Total length of the set; single points add 0.
    pub fn measure(&self) -> i128 {
        self.map
            .values()
            .map(|&(lo, hi)| hi.value() as i128 - lo.value() as i128)
            .sum()
    }

    /// The part of the window from lo to hi that is not in the set.
    pub fn complement(&self, lo: Bound, hi: Bound) -> Vec<(Bound, Bound)> {
        let mut window = IntervalSet::new();
        window.insert(lo, hi);
        for &(l, h) in self.map.values() {
            if intersects((l, h), (lo, hi)) {
                window.remove(l, h);
            }
        }
        window.ranges()
    }
}

impl fmt::Display for IntervalSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{{")?;
        for (i, &(lo, hi)) in self.map.values().enumerate() {
            if i > 0 {
                write!(f, ", ")?;
            }
            let open = if lo.is_closed() { '[' } else { '(' };
            let close = if hi.is_closed() { ']' } else { ')' };
            write!(f, "{open}{},{}{close}", lo.value(), hi.value())?;
        }
        write!(f, "}}")
    }
}
