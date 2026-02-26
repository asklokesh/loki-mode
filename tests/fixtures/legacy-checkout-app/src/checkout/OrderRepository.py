"""Order repository with direct SQL queries (no ORM)."""

import uuid
from datetime import datetime


class OrderRepository:
    """Direct SQL queries for order storage. Migration target: ORM."""

    def __init__(self):
        self._orders = {}  # In-memory store (simulates DB)

    def create_order(self, user_id, items, total, payment_id=None):
        """Create a new order. Uses raw SQL patterns."""
        order_id = str(uuid.uuid4())[:8]
        order = {
            "id": order_id,
            "user_id": user_id,
            "items": items,
            "total": total,
            "payment_id": payment_id,
            "status": "created",
            "created_at": datetime.now().isoformat(),  # BUG: no timezone
        }
        self._orders[order_id] = order
        return order

    def get_order(self, order_id):
        """Get order by ID. Simulates: SELECT * FROM orders WHERE id = ?"""
        return self._orders.get(order_id)

    def list_orders(self, user_id):
        """List orders for user. Simulates: SELECT * FROM orders WHERE user_id = ?"""
        return [o for o in self._orders.values() if o["user_id"] == user_id]

    def update_status(self, order_id, status):
        """Update order status. Simulates: UPDATE orders SET status = ? WHERE id = ?"""
        if order_id in self._orders:
            self._orders[order_id]["status"] = status
            return True
        return False
