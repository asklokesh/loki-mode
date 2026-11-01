"""In-memory user store."""
from accounts.models import User


class UserStore:
    def __init__(self):
        self._users = {}
        self._next = 1

    def add(self, email, name):
        user = User(id=self._next, email=email, name=name)
        self._users[user.id] = user
        self._next += 1
        return user

    def find_by_email(self, email):
        for user in self._users.values():
            if user.email == email:
                return user
        return None

    def all(self):
        return list(self._users.values())
