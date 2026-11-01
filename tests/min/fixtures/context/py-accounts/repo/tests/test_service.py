from accounts.service import register_user
from accounts.store import UserStore


def test_register():
    s = UserStore()
    u = register_user(s, "a@b.co", "Ann")
    assert u.id == 1
