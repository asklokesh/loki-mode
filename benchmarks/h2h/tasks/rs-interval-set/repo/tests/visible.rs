use intervalkit::{Bound, IntervalSet};

#[test]
fn contains_respects_endpoint_kinds() {
    let mut set = IntervalSet::new();
    set.insert(Bound::Closed(2), Bound::Open(5));
    assert!(!set.contains(1.5));
    assert!(set.contains(2.0));
    assert!(set.contains(4.5));
    assert!(!set.contains(5.0));

    let mut open = IntervalSet::new();
    open.insert(Bound::Open(2), Bound::Closed(5));
    assert!(!open.contains(2.0));
    assert!(open.contains(2.1));
    assert!(open.contains(5.0));
}

#[test]
fn disjoint_intervals_come_back_sorted() {
    let mut set = IntervalSet::new();
    set.insert(Bound::Open(10), Bound::Open(12));
    set.insert(Bound::Closed(-3), Bound::Open(0));
    assert_eq!(
        set.ranges(),
        vec![
            (Bound::Closed(-3), Bound::Open(0)),
            (Bound::Open(10), Bound::Open(12))
        ]
    );
}

#[test]
fn empty_intervals_are_ignored_but_points_are_kept() {
    let mut set = IntervalSet::new();
    set.insert(Bound::Closed(4), Bound::Open(4));
    set.insert(Bound::Open(9), Bound::Closed(1));
    assert!(set.ranges().is_empty());
    set.insert(Bound::Closed(7), Bound::Closed(7));
    assert_eq!(set.ranges(), vec![(Bound::Closed(7), Bound::Closed(7))]);
    assert!(set.contains(7.0));
}
