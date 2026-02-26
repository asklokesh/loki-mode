# Legacy Checkout App

Test fixture for Loki Mode migration engine validation.

## Requirements
- Python 3.8+

## Known Issues (for characterization testing)
1. CheckoutService rounds down cents on discounts > 50%
2. PaymentProcessor retries without deduplication
3. AuthService accepts expired tokens for 5 minutes
4. date_utils uses system timezone, not UTC

## Running Tests
python -m pytest tests/ -q
