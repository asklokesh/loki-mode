use std::collections::BTreeMap;

/// One line of an order: a quantity of a single SKU.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderLine {
    pub sku: String,
    pub qty: u32,
}

/// A customer order made of lines. The same SKU may appear on several lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    pub id: String,
    lines: Vec<OrderLine>,
}

impl Order {
    pub fn new(id: &str) -> Self {
        Order {
            id: id.to_string(),
            lines: Vec::new(),
        }
    }

    /// Appends a line and returns the order so calls can be chained.
    pub fn with_line(mut self, sku: &str, qty: u32) -> Self {
        self.add_line(sku, qty);
        self
    }

    pub fn add_line(&mut self, sku: &str, qty: u32) {
        self.lines.push(OrderLine {
            sku: sku.to_string(),
            qty,
        });
    }

    pub fn lines(&self) -> &[OrderLine] {
        &self.lines
    }

    /// Total units across all lines.
    pub fn total_units(&self) -> u32 {
        self.lines.iter().map(|l| l.qty).sum()
    }

    /// One entry per distinct SKU with its lines summed, sorted by SKU; zero totals are left out.
    pub fn quantities_by_sku(&self) -> Vec<(String, u32)> {
        let mut totals: BTreeMap<&str, u32> = BTreeMap::new();
        for line in &self.lines {
            *totals.entry(line.sku.as_str()).or_insert(0) += line.qty;
        }
        totals
            .into_iter()
            .filter(|&(_, qty)| qty > 0)
            .map(|(sku, qty)| (sku.to_string(), qty))
            .collect()
    }
}
