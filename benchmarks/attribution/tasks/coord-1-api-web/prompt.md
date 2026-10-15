This repo holds two packages that must change together: `api/` (a service) and `web/` (its consumer).

Change the orders API to cursor pagination and update the web client to match.

1. `api/orders.py`: `list_orders(cursor=None, limit=2)` must return a dict
   `{"items": [...], "next_cursor": <int or None>}` instead of the current
   `{"orders": [...], "total": N}`.
   - `cursor` is the id of the last order the caller already has. Return orders with `id > cursor`, in id order. `cursor=None` starts from the beginning.
   - At most `limit` items per page. `next_cursor` is the id of the last item on the page when more orders remain, otherwise `None`.
   - `limit` must be an int from 1 to 100 inclusive, otherwise raise `ValueError`.
   - Read the module-level `ORDERS` list at call time (it may be replaced).
2. `web/client.py`: `fetch_all_orders()` must follow `next_cursor` until it is `None` and return every order across all pages, in order, using `list_orders` only (never read `ORDERS` directly). `total_amount()` must stay correct: the sum of `amount` over all orders.

Both packages must work together after your change. Do not add dependencies.
