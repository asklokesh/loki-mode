use stockkit::{Inventory, Order};

#[test]
fn stock_accumulates_per_sku() {
    let mut inv = Inventory::new();
    inv.add_stock("apple", 5);
    inv.add_stock("apple", 3);
    inv.add_stock("pear", 0);
    assert_eq!(inv.on_hand("apple"), 8);
    assert_eq!(inv.on_hand("pear"), 0);
    assert_eq!(inv.on_hand("plum"), 0);
    assert!(inv.knows("pear"));
    assert!(!inv.knows("plum"));
}

#[test]
fn order_keeps_lines_in_insertion_order() {
    let order = Order::new("o-1").with_line("pear", 2).with_line("apple", 1);
    let skus: Vec<&str> = order.lines().iter().map(|l| l.sku.as_str()).collect();
    assert_eq!(skus, ["pear", "apple"]);
    assert_eq!(order.total_units(), 3);
}
