use stockkit::{Inventory, Order, ReservationId, ReserveError};

fn stocked() -> Inventory {
    let mut inv = Inventory::new();
    inv.add_stock("apple", 10);
    inv.add_stock("pear", 4);
    inv.add_stock("plum", 0);
    inv
}

#[test]
fn quantities_are_summed_and_sorted() {
    let order = Order::new("o")
        .with_line("pear", 2)
        .with_line("apple", 1)
        .with_line("pear", 3)
        .with_line("fig", 0);
    assert_eq!(
        order.quantities_by_sku(),
        vec![("apple".to_string(), 1), ("pear".to_string(), 5)]
    );
    assert!(Order::new("empty").quantities_by_sku().is_empty());
}

#[test]
fn reserve_lowers_available_but_not_on_hand() {
    let mut inv = stocked();
    let order = Order::new("o").with_line("apple", 3).with_line("pear", 4);
    inv.reserve(&order).unwrap();
    assert_eq!(inv.available("apple"), 7);
    assert_eq!(inv.available("pear"), 0);
    assert_eq!(inv.on_hand("apple"), 10);
    assert_eq!(inv.on_hand("pear"), 4);
    assert_eq!(inv.available("nothing"), 0);
}

#[test]
fn duplicate_lines_are_summed_before_checking() {
    let mut inv = stocked();
    let order = Order::new("o").with_line("pear", 3).with_line("pear", 2);
    assert_eq!(
        inv.reserve(&order),
        Err(ReserveError::Insufficient {
            sku: "pear".to_string(),
            requested: 5,
            available: 4
        })
    );
    assert_eq!(inv.available("pear"), 4);
}

#[test]
fn failure_reserves_nothing() {
    let mut inv = stocked();
    let order = Order::new("o").with_line("apple", 2).with_line("pear", 9);
    assert!(inv.reserve(&order).is_err());
    assert_eq!(inv.available("apple"), 10);
    assert_eq!(inv.available("pear"), 4);
}

#[test]
fn unknown_sku_is_reported() {
    let mut inv = stocked();
    let order = Order::new("o").with_line("kiwi", 1).with_line("apple", 1);
    assert_eq!(
        inv.reserve(&order),
        Err(ReserveError::UnknownSku("kiwi".to_string()))
    );
    assert_eq!(inv.available("apple"), 10);
}

#[test]
fn first_failing_sku_in_sorted_order_wins() {
    let mut inv = stocked();
    let order = Order::new("o")
        .with_line("zucchini", 1)
        .with_line("pear", 5);
    assert_eq!(
        inv.reserve(&order),
        Err(ReserveError::Insufficient {
            sku: "pear".to_string(),
            requested: 5,
            available: 4
        })
    );
    let order = Order::new("o").with_line("pear", 5).with_line("banana", 1);
    assert_eq!(
        inv.reserve(&order),
        Err(ReserveError::UnknownSku("banana".to_string()))
    );
}

#[test]
fn reservations_compete_for_stock() {
    let mut inv = stocked();
    inv.reserve(&Order::new("a").with_line("pear", 3)).unwrap();
    assert_eq!(
        inv.reserve(&Order::new("b").with_line("pear", 2)),
        Err(ReserveError::Insufficient {
            sku: "pear".to_string(),
            requested: 2,
            available: 1
        })
    );
    assert!(inv.reserve(&Order::new("c").with_line("pear", 1)).is_ok());
    assert_eq!(inv.available("pear"), 0);
}

#[test]
fn release_frees_units() {
    let mut inv = stocked();
    let id = inv.reserve(&Order::new("o").with_line("apple", 6)).unwrap();
    assert_eq!(inv.release(id), Ok(()));
    assert_eq!(inv.available("apple"), 10);
    assert_eq!(inv.on_hand("apple"), 10);
    assert_eq!(inv.release(id), Err(ReserveError::UnknownReservation));
    assert_eq!(inv.commit(id), Err(ReserveError::UnknownReservation));
}

#[test]
fn commit_ships_units() {
    let mut inv = stocked();
    let id = inv
        .reserve(&Order::new("o").with_line("apple", 6).with_line("pear", 1))
        .unwrap();
    assert_eq!(inv.available("apple"), 4);
    assert_eq!(inv.commit(id), Ok(()));
    assert_eq!(inv.on_hand("apple"), 4);
    assert_eq!(inv.available("apple"), 4);
    assert_eq!(inv.on_hand("pear"), 3);
    assert_eq!(inv.commit(id), Err(ReserveError::UnknownReservation));
    assert_eq!(inv.release(id), Err(ReserveError::UnknownReservation));
}

#[test]
fn ids_are_unique_and_unknown_ids_rejected() {
    let mut inv = stocked();
    let a = inv.reserve(&Order::new("a").with_line("apple", 1)).unwrap();
    let b = inv.reserve(&Order::new("b").with_line("apple", 1)).unwrap();
    inv.release(a).unwrap();
    let c = inv.reserve(&Order::new("c").with_line("apple", 1)).unwrap();
    assert_ne!(a, b);
    assert_ne!(a, c);
    assert_ne!(b, c);
    assert_eq!(
        inv.release(ReservationId(9_999)),
        Err(ReserveError::UnknownReservation)
    );
}

#[test]
fn empty_order_gets_an_id_that_holds_nothing() {
    let mut inv = stocked();
    let order = Order::new("o").with_line("plum", 0).with_line("ghost", 0);
    let id = inv.reserve(&order).unwrap();
    assert_eq!(inv.commit(id), Ok(()));
    assert_eq!(inv.on_hand("apple"), 10);
}

#[test]
fn stock_added_later_becomes_available() {
    let mut inv = stocked();
    inv.reserve(&Order::new("o").with_line("pear", 4)).unwrap();
    inv.add_stock("pear", 2);
    assert_eq!(inv.on_hand("pear"), 6);
    assert_eq!(inv.available("pear"), 2);
}
