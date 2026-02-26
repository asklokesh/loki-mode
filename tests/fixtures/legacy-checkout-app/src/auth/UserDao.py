"""User data access with raw SQL patterns."""


class UserDao:
    """Raw SQL user data access. Migration target: ORM."""

    def __init__(self):
        self._users = {}

    def create_user(self, username, email, password_hash):
        """Simulates: INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)"""
        user_id = len(self._users) + 1
        self._users[user_id] = {
            "id": user_id,
            "username": username,
            "email": email,
            "password_hash": password_hash,
        }
        return self._users[user_id]

    def get_by_username(self, username):
        """Simulates: SELECT * FROM users WHERE username = ?"""
        for user in self._users.values():
            if user["username"] == username:
                return user
        return None

    def get_by_id(self, user_id):
        """Simulates: SELECT * FROM users WHERE id = ?"""
        return self._users.get(user_id)
