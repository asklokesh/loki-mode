use std::collections::HashMap;

/// Units on hand per SKU.
#[derive(Debug, Default)]
pub struct Inventory {
    on_hand: HashMap<String, u32>,
}

impl Inventory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds units of a SKU. Adding 0 units still registers the SKU as known.
    pub fn add_stock(&mut self, sku: &str, qty: u32) {
        *self.on_hand.entry(sku.to_string()).or_insert(0) += qty;
    }

    /// Units physically on hand; 0 for an unknown SKU.
    pub fn on_hand(&self, sku: &str) -> u32 {
        self.on_hand.get(sku).copied().unwrap_or(0)
    }

    /// Whether the SKU has ever been added with add_stock.
    pub fn knows(&self, sku: &str) -> bool {
        self.on_hand.contains_key(sku)
    }
}
