"""Sparse test coverage - only 2 happy-path tests.

This intentionally has minimal coverage to simulate a real legacy codebase
where tests are incomplete.
"""

import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from checkout.CheckoutService import CheckoutService


def test_normal_checkout():
    """Happy path: normal checkout without discount."""
    service = CheckoutService()
    cart = {
        "items": [
            {"name": "Widget", "price": 10.00, "quantity": 2},
        ],
    }
    result = service.process_checkout(cart, "user_123")
    assert result["status"] == "success"
    assert result["total"] > 0


def test_free_checkout():
    """Happy path: 100% discount = free order."""
    service = CheckoutService()
    cart = {
        "items": [
            {"name": "Widget", "price": 10.00, "quantity": 1},
        ],
        "discount_pct": 100,
    }
    result = service.process_checkout(cart, "user_123")
    assert result["status"] == "success"
    assert result["total"] == 0.0


if __name__ == "__main__":
    test_normal_checkout()
    test_free_checkout()
    print("All tests passed")
