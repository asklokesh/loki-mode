"""Payment processor with retry logic but no deduplication."""

import time
import uuid


class PaymentProcessor:
    """Hardcoded Stripe-like payment calls. Seam target for migration."""

    RETRY_COUNT = 3
    RETRY_DELAY = 0.1  # seconds

    def charge(self, user_id, amount):
        """Charge a user. Retries 3x on timeout but DOES NOT deduplicate.

        BUG: If retry succeeds after timeout, user may be charged multiple times.
        A real Stripe integration would use idempotency keys.
        """
        payment_id = str(uuid.uuid4())

        for attempt in range(self.RETRY_COUNT):
            try:
                result = self._call_payment_api(user_id, amount, payment_id)
                return result
            except TimeoutError:
                if attempt < self.RETRY_COUNT - 1:
                    time.sleep(self.RETRY_DELAY)
                    # BUG: generates NEW payment_id on retry instead of reusing
                    payment_id = str(uuid.uuid4())
                    continue
                return {"status": "failed", "error": "payment_timeout"}

        return {"status": "failed", "error": "max_retries"}

    def _call_payment_api(self, user_id, amount, payment_id):
        """Simulated payment API call."""
        # In production this would call Stripe/etc
        return {
            "status": "success",
            "payment_id": payment_id,
            "amount": amount,
            "user_id": user_id,
        }

    def refund(self, payment_id, amount=None):
        """Refund a payment."""
        return {
            "status": "success",
            "refund_id": str(uuid.uuid4()),
            "payment_id": payment_id,
            "amount": amount,
        }
