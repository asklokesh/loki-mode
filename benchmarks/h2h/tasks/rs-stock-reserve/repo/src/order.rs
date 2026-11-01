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
}
