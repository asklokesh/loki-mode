use std::collections::HashMap;

use crate::order::Order;

/// Identifies one active reservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ReservationId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReserveError {
    UnknownSku(String),
    Insufficient {
        sku: String,
        requested: u32,
        available: u32,
    },
    UnknownReservation,
}

/// Units on hand per SKU, plus the units held by active reservations.
#[derive(Debug, Default)]
pub struct Inventory {
    on_hand: HashMap<String, u32>,
    reserved: HashMap<String, u32>,
    reservations: HashMap<ReservationId, Vec<(String, u32)>>,
    next_id: u64,
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

    /// Units on hand that no active reservation holds.
    pub fn available(&self, sku: &str) -> u32 {
        self.on_hand(sku) - self.reserved.get(sku).copied().unwrap_or(0)
    }

    /// Holds every line of the order, or nothing if any SKU cannot be satisfied.
    pub fn reserve(&mut self, order: &Order) -> Result<ReservationId, ReserveError> {
        let wanted = order.quantities_by_sku();
        for (sku, qty) in &wanted {
            if !self.knows(sku) {
                return Err(ReserveError::UnknownSku(sku.clone()));
            }
            let available = self.available(sku);
            if *qty > available {
                return Err(ReserveError::Insufficient {
                    sku: sku.clone(),
                    requested: *qty,
                    available,
                });
            }
        }
        for (sku, qty) in &wanted {
            *self.reserved.entry(sku.clone()).or_insert(0) += qty;
        }
        self.next_id += 1;
        let id = ReservationId(self.next_id);
        self.reservations.insert(id, wanted);
        Ok(id)
    }

    /// Ends a reservation without shipping; on_hand is unchanged.
    pub fn release(&mut self, id: ReservationId) -> Result<(), ReserveError> {
        self.end(id).map(|_| ())
    }

    /// Ships a reservation: on_hand drops by the held quantities.
    pub fn commit(&mut self, id: ReservationId) -> Result<(), ReserveError> {
        for (sku, qty) in self.end(id)? {
            if let Some(n) = self.on_hand.get_mut(&sku) {
                *n -= qty;
            }
        }
        Ok(())
    }

    fn end(&mut self, id: ReservationId) -> Result<Vec<(String, u32)>, ReserveError> {
        let held = self
            .reservations
            .remove(&id)
            .ok_or(ReserveError::UnknownReservation)?;
        for (sku, qty) in &held {
            if let Some(n) = self.reserved.get_mut(sku) {
                *n -= qty;
            }
        }
        Ok(held)
    }
}
