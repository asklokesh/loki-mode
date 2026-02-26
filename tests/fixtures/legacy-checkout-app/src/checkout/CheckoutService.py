"""Checkout service with 3 code paths and a rounding bug."""

from config.settings import TAX_RATE
from checkout.PaymentProcessor import PaymentProcessor
from checkout.OrderRepository import OrderRepository


class CheckoutService:
    """Main checkout service. Handles cart -> order flow."""

    def __init__(self):
        self.payment = PaymentProcessor()
        self.orders = OrderRepository()

    def process_checkout(self, cart, user_id):
        """Process a checkout. 3 paths: normal, discounted, free."""
        subtotal = sum(item["price"] * item["quantity"] for item in cart["items"])
        discount_pct = cart.get("discount_pct", 0)

        if discount_pct >= 100:
            # Free order path
            total = 0.0
            payment_result = {"status": "skipped", "reason": "free_order"}
        elif discount_pct > 0:
            # BUG: Rounds down cents on discounts > 50% due to multiply-before-divide
            # Should be: subtotal * (1 - discount_pct/100)
            # Actually does: int(subtotal * (100 - discount_pct)) / 100
            discounted = int(subtotal * (100 - discount_pct)) / 100
            tax = discounted * TAX_RATE
            total = round(discounted + tax, 2)
            payment_result = self.payment.charge(user_id, total)
        else:
            # Normal path
            tax = subtotal * TAX_RATE
            total = round(subtotal + tax, 2)
            payment_result = self.payment.charge(user_id, total)

        if payment_result.get("status") == "failed":
            return {"status": "failed", "error": payment_result.get("error")}

        order = self.orders.create_order(
            user_id=user_id,
            items=cart["items"],
            total=total,
            payment_id=payment_result.get("payment_id"),
        )

        return {"status": "success", "order_id": order["id"], "total": total}
