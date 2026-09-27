import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, _, b = req("GET", "/api/products")
    prods = jbody(b)
    expect(s == 200 and sorted(p.get("id") for p in prods) == ["mug", "shirt", "sticker"], "products wrong: %r" % prods)
    s, _, b = req("GET", "/api/cart")
    c = jbody(b)
    expect(s == 200 and c.get("items") == [] and c.get("total_cents") == 0, "empty cart wrong: %r" % c)
    s, _, _ = req("POST", "/api/cart/items", {"product_id": "mug", "qty": 2})
    expect(s == 201, "add mug -> %s" % s)
    s, _, b = req("GET", "/api/cart")
    c = jbody(b)
    expect(c.get("subtotal_cents") == 2400 and c.get("discount_cents") == 0 and c.get("total_cents") == 2400, "cart after 2 mugs: %r" % c)
    s, _, _ = req("POST", "/api/cart/items", {"product_id": "shirt", "qty": 4})
    expect(s == 201, "add shirts -> %s" % s)
    s, _, b = req("GET", "/api/cart")
    c = jbody(b)
    # 2*1200 + 4*2000 = 10400 >= 10000 -> 10% discount = 1040
    expect(c.get("subtotal_cents") == 10400 and c.get("discount_cents") == 1040 and c.get("total_cents") == 9360, "discount wrong: %r" % c)
    s, _, _ = req("POST", "/api/cart/items", {"product_id": "mug", "qty": 1})
    s, _, b = req("GET", "/api/cart")
    mug = [i for i in jbody(b).get("items", []) if i.get("product_id") == "mug"]
    expect(len(mug) == 1 and mug[0].get("qty") == 3, "re-adding mug should merge qty to 3: %r" % mug)
    s, _, _ = req("POST", "/api/cart/items", {"product_id": "ghost", "qty": 1})
    expect(s == 404, "unknown product should be 404, got %s" % s)
    s, _, _ = req("POST", "/api/cart/items", {"product_id": "mug", "qty": 0})
    expect(s == 400, "qty 0 should be 400, got %s" % s)


run(check)
