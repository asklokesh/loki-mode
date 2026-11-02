use intervalkit::{Bound, IntervalSet};
use Bound::{Closed as C, Open as O};

fn set_of(ranges: &[(Bound, Bound)]) -> IntervalSet {
    let mut s = IntervalSet::new();
    for &(a, b) in ranges {
        s.insert(a, b);
    }
    s
}

fn none() -> Vec<(Bound, Bound)> {
    Vec::new()
}

#[test]
fn merge_rules_at_a_shared_endpoint() {
    assert_eq!(
        set_of(&[(C(1), O(3)), (C(3), C(5))]).ranges(),
        vec![(C(1), C(5))]
    );
    assert_eq!(
        set_of(&[(C(3), C(5)), (C(1), O(3))]).ranges(),
        vec![(C(1), C(5))]
    );
    assert_eq!(
        set_of(&[(C(1), C(3)), (O(3), O(5))]).ranges(),
        vec![(C(1), O(5))]
    );
    assert_eq!(
        set_of(&[(O(1), C(3)), (C(3), O(5))]).ranges(),
        vec![(O(1), O(5))]
    );
    assert_eq!(
        set_of(&[(O(1), O(3)), (O(3), O(5))]).ranges(),
        vec![(O(1), O(3)), (O(3), O(5))]
    );
    assert_eq!(
        set_of(&[(C(1), O(3)), (O(3), C(5))]).ranges(),
        vec![(C(1), O(3)), (O(3), C(5))]
    );
}

#[test]
fn overlapping_and_nested_intervals_merge() {
    assert_eq!(
        set_of(&[(C(1), O(4)), (O(2), C(6))]).ranges(),
        vec![(C(1), C(6))]
    );
    assert_eq!(
        set_of(&[(O(1), O(9)), (C(2), C(3))]).ranges(),
        vec![(O(1), O(9))]
    );
    let mut s = set_of(&[(C(1), C(2)), (C(4), C(5)), (O(7), O(8)), (C(20), C(21))]);
    s.insert(O(2), O(8));
    assert_eq!(s.ranges(), vec![(C(1), O(8)), (C(20), C(21))]);
}

#[test]
fn endpoint_kinds_upgrade_when_the_same_value_is_added() {
    assert_eq!(
        set_of(&[(O(1), O(3)), (C(1), C(1))]).ranges(),
        vec![(C(1), O(3))]
    );
    assert_eq!(
        set_of(&[(O(1), O(3)), (C(3), C(3))]).ranges(),
        vec![(O(1), C(3))]
    );
    assert_eq!(
        set_of(&[(C(1), O(3)), (O(1), C(3))]).ranges(),
        vec![(C(1), C(3))]
    );
    assert_eq!(
        set_of(&[(O(1), O(3)), (O(1), C(3))]).ranges(),
        vec![(O(1), C(3))]
    );
}

#[test]
fn single_points() {
    assert_eq!(
        set_of(&[(C(2), C(2)), (O(2), O(5))]).ranges(),
        vec![(C(2), O(5))]
    );
    assert_eq!(
        set_of(&[(C(2), C(2)), (O(1), O(2))]).ranges(),
        vec![(O(1), C(2))]
    );
    assert_eq!(
        set_of(&[(O(1), O(2)), (O(2), O(3)), (C(2), C(2))]).ranges(),
        vec![(O(1), O(3))]
    );
    assert_eq!(
        set_of(&[(C(2), C(2)), (C(2), C(2))]).ranges(),
        vec![(C(2), C(2))]
    );
    assert_eq!(
        set_of(&[(C(3), C(3)), (C(2), C(2))]).ranges(),
        vec![(C(2), C(2)), (C(3), C(3))]
    );
    assert_eq!(
        set_of(&[(O(1), O(9)), (C(5), C(5))]).ranges(),
        vec![(O(1), O(9))]
    );
}

#[test]
fn empty_intervals_are_ignored_and_the_domain_is_real() {
    let mut s = set_of(&[
        (O(2), O(2)),
        (C(2), O(2)),
        (O(2), C(2)),
        (O(3), O(2)),
        (C(3), C(1)),
    ]);
    assert!(s.is_empty());
    assert_eq!(s.ranges(), none());
    s.insert(O(2), O(3));
    assert_eq!(s.ranges(), vec![(O(2), O(3))]);
    assert!(s.contains(2.5));
    assert!(!s.contains(2.0));
    assert!(!s.contains(3.0));
    s.remove(O(2), O(2));
    s.remove(C(3), O(3));
    s.remove(C(9), C(1));
    assert_eq!(s.ranges(), vec![(O(2), O(3))]);
}

#[test]
fn removing_a_point_or_an_open_interval_splits() {
    let mut s = set_of(&[(C(1), C(5))]);
    s.remove(C(2), C(2));
    assert_eq!(s.ranges(), vec![(C(1), O(2)), (O(2), C(5))]);
    assert!(!s.contains(2.0));
    assert!(s.contains(1.999));
    assert!(s.contains(2.001));

    let mut s = set_of(&[(C(1), C(5))]);
    s.remove(O(2), O(4));
    assert_eq!(s.ranges(), vec![(C(1), C(2)), (C(4), C(5))]);

    let mut s = set_of(&[(C(1), C(5))]);
    s.remove(O(1), O(5));
    assert_eq!(s.ranges(), vec![(C(1), C(1)), (C(5), C(5))]);

    let mut s = set_of(&[(O(1), O(5))]);
    s.remove(C(1), C(5));
    assert!(s.is_empty());
}

#[test]
fn removal_at_an_endpoint() {
    let mut s = set_of(&[(C(1), O(3))]);
    s.remove(C(3), C(5));
    assert_eq!(s.ranges(), vec![(C(1), O(3))]);

    let mut s = set_of(&[(C(1), C(3))]);
    s.remove(O(3), O(5));
    assert_eq!(s.ranges(), vec![(C(1), C(3))]);

    let mut s = set_of(&[(C(1), C(3))]);
    s.remove(C(3), C(5));
    assert_eq!(s.ranges(), vec![(C(1), O(3))]);

    let mut s = set_of(&[(C(1), C(3))]);
    s.remove(C(0), C(1));
    assert_eq!(s.ranges(), vec![(O(1), C(3))]);
}

#[test]
fn removal_across_several_intervals() {
    let mut s = set_of(&[(C(0), C(5)), (O(10), O(15)), (C(20), C(25))]);
    s.remove(O(3), C(22));
    assert_eq!(s.ranges(), vec![(C(0), C(3)), (O(22), C(25))]);
}

#[test]
fn complement_flips_endpoint_kinds() {
    let s = set_of(&[(C(2), O(4)), (O(6), C(8))]);
    assert_eq!(
        s.complement(C(0), C(10)),
        vec![(C(0), O(2)), (C(4), C(6)), (O(8), C(10))]
    );
    assert_eq!(s.complement(O(2), O(4)), none());
    assert_eq!(s.complement(C(2), C(4)), vec![(C(4), C(4))]);
    assert_eq!(s.complement(O(0), C(2)), vec![(O(0), O(2))]);
    assert_eq!(s.complement(C(6), C(6)), vec![(C(6), C(6))]);
    assert_eq!(s.complement(O(6), O(6)), none());
    assert_eq!(s.complement(C(9), C(1)), none());
    assert_eq!(s.complement(C(4), C(6)), vec![(C(4), C(6))]);
    assert_eq!(
        IntervalSet::new().complement(O(-3), C(3)),
        vec![(O(-3), C(3))]
    );
}

#[test]
fn contains_measure_and_is_empty() {
    let mut s = IntervalSet::new();
    assert!(s.is_empty());
    assert_eq!(s.measure(), 0);
    s.insert(C(0), C(1));
    s.insert(O(2), O(3));
    s.insert(C(5), C(5));
    assert!(!s.is_empty());
    assert_eq!(s.measure(), 2);
    assert!(s.contains(5.0));
    assert!(!s.contains(4.99));
    assert!(s.contains(1.0));
    assert!(!s.contains(1.5));
    assert!(s.contains(-0.0));
}

#[test]
fn display_format() {
    assert_eq!(IntervalSet::new().to_string(), "{}");
    let s = set_of(&[(C(7), C(7)), (O(4), C(5)), (C(1), O(3))]);
    assert_eq!(s.to_string(), "{[1,3), (4,5], [7,7]}");
    assert_eq!(set_of(&[(O(-3), C(0))]).to_string(), "{(-3,0]}");
}

#[test]
fn extreme_endpoints_do_not_overflow() {
    let mut s = set_of(&[(C(i64::MIN), O(0)), (C(0), C(i64::MAX))]);
    assert_eq!(s.ranges(), vec![(C(i64::MIN), C(i64::MAX))]);
    assert_eq!(s.measure(), u64::MAX as i128);
    s.remove(O(i64::MIN), O(i64::MAX));
    assert_eq!(
        s.ranges(),
        vec![(C(i64::MIN), C(i64::MIN)), (C(i64::MAX), C(i64::MAX))]
    );
    assert_eq!(s.measure(), 0);
    assert_eq!(
        s.complement(C(i64::MIN), C(i64::MAX)),
        vec![(O(i64::MIN), O(i64::MAX))]
    );
    assert_eq!(
        s.to_string(),
        format!("{{[{0},{0}], [{1},{1}]}}", i64::MIN, i64::MAX)
    );
}

/// Integer endpoints mean a set is fully described by membership at every
/// integer and every half-integer, so a model over doubled coordinates
/// (cell d stands for the number d / 2) checks every operation exactly.
#[test]
fn matches_brute_force_model() {
    const LO: i64 = -10;
    const HI: i64 = 10;
    const CELLS: usize = (4 * HI + 1) as usize;
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move |m: u64| {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) % m
    };
    let bound = |next: &mut dyn FnMut(u64) -> u64| {
        let v = LO + next((HI - LO + 1) as u64) as i64;
        if next(2) == 0 {
            C(v)
        } else {
            O(v)
        }
    };
    let cell_range = |lo: Bound, hi: Bound| -> (i64, i64) {
        let first = 2 * lo.value() + if lo.is_closed() { 0 } else { 1 };
        let last = 2 * hi.value() - if hi.is_closed() { 0 } else { 1 };
        (first, last)
    };
    let idx = |d: i64| (d - 2 * LO) as usize;
    let runs = |cells: &[bool]| -> Vec<(Bound, Bound)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < cells.len() {
            if cells[i] {
                let start = i;
                while i + 1 < cells.len() && cells[i + 1] {
                    i += 1;
                }
                let (d0, d1) = (start as i64 + 2 * LO, i as i64 + 2 * LO);
                let lo = if d0 % 2 == 0 {
                    C(d0 / 2)
                } else {
                    O((d0 - 1) / 2)
                };
                let hi = if d1 % 2 == 0 {
                    C(d1 / 2)
                } else {
                    O((d1 + 1) / 2)
                };
                out.push((lo, hi));
            }
            i += 1;
        }
        out
    };

    let mut set = IntervalSet::new();
    let mut model = [false; CELLS];
    for step in 0..3000 {
        let a = bound(&mut next);
        let b = bound(&mut next);
        let (first, last) = cell_range(a, b);
        let removing = next(3) == 0;
        if removing {
            set.remove(a, b);
        } else {
            set.insert(a, b);
        }
        for d in first..=last {
            model[idx(d)] = !removing;
        }
        assert_eq!(set.ranges(), runs(&model), "step {step} after {a:?}..{b:?}");
        let odd_cells = (2 * LO..=2 * HI)
            .filter(|d| d % 2 != 0 && model[idx(*d)])
            .count() as i128;
        assert_eq!(set.measure(), odd_cells, "step {step}");
        assert_eq!(set.is_empty(), !model.contains(&true), "step {step}");
        for d in 2 * LO..=2 * HI {
            assert_eq!(
                set.contains(d as f64 / 2.0),
                model[idx(d)],
                "step {step} x {}",
                d as f64 / 2.0
            );
        }
        let w0 = bound(&mut next);
        let w1 = bound(&mut next);
        let (first, last) = cell_range(w0, w1);
        let mut gaps = [false; CELLS];
        for d in first..=last {
            gaps[idx(d)] = !model[idx(d)];
        }
        assert_eq!(
            set.complement(w0, w1),
            runs(&gaps),
            "step {step} window {w0:?}..{w1:?}"
        );
    }
}

/// Reference membership on a canonical, sorted interval list by binary search.
fn reference_contains(ranges: &[(Bound, Bound)], x: f64) -> bool {
    let idx = ranges.partition_point(|&(lo, _)| lo.value() as f64 <= x);
    ranges[..idx].iter().rev().take(2).any(|&(lo, hi)| {
        let above = if lo.is_closed() {
            x >= lo.value() as f64
        } else {
            x > lo.value() as f64
        };
        let below = if hi.is_closed() {
            x <= hi.value() as f64
        } else {
            x < hi.value() as f64
        };
        above && below
    })
}

#[test]
fn large_workload_runs_in_logarithmic_time() {
    let mut seed: u64 = 0x1234_5678_9abc_def1;
    let mut next = move |m: u64| {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) % m
    };
    let mut set = IntervalSet::new();
    let mut hits = 0u32;
    let start = std::time::Instant::now();
    // Positions sweep downward from 1e9 towards 0 with random jitter, so most
    // new intervals land in front of the ones already stored.
    for i in 0..300_000 {
        let a = 1_000_000_000 - i * 3_333 + next(3_000) as i64;
        let b = a + next(1_000) as i64;
        let lo = if next(2) == 0 { C(a) } else { O(a) };
        let hi = if next(2) == 0 { C(b) } else { O(b) };
        if next(4) == 0 {
            set.remove(lo, hi);
        } else {
            set.insert(lo, hi);
        }
        let x = next(2_000_000_000) as f64 / 2.0;
        if set.contains(x) {
            hits += 1;
        }
    }
    let elapsed = start.elapsed();
    println!("interval workload: {elapsed:?}");
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "300000 inserts/removes plus 300000 contains took {elapsed:?}"
    );

    let ranges = set.ranges();
    assert!(ranges.len() > 50_000, "only {} intervals", ranges.len());
    assert!(hits > 1_000, "only {hits} contains hits");
    for w in ranges.windows(2) {
        let (prev_hi, next_lo) = (w[0].1, w[1].0);
        assert!(
            prev_hi.value() < next_lo.value()
                || (prev_hi.value() == next_lo.value()
                    && !prev_hi.is_closed()
                    && !next_lo.is_closed()),
            "not canonical: {:?} then {:?}",
            w[0],
            w[1]
        );
    }
    for _ in 0..2_000 {
        let x = next(2_000_000_000) as f64 / 2.0;
        assert_eq!(set.contains(x), reference_contains(&ranges, x), "x = {x}");
    }
}
