//! A tiny warehouse model: stock levels and customer orders.

pub mod order;
pub mod stock;

pub use order::{Order, OrderLine};
pub use stock::Inventory;
