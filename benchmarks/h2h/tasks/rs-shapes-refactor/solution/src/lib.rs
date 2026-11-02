//! Area and perimeter of simple 2D shapes described by a kind name and parameters.

pub mod area;
pub mod perimeter;
pub mod shape;

pub use area::area;
pub use perimeter::perimeter;
pub use shape::{Shape, ShapeError};
