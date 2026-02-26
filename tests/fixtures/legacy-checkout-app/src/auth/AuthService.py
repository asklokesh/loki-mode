"""Auth service with expired token grace period bug."""

import hashlib
import time
import uuid


class AuthService:
    """Session-based authentication. Migration target: JWT."""

    TOKEN_EXPIRY = 3600  # 1 hour
    GRACE_PERIOD = 300   # BUG: accepts expired tokens for 5 minutes (undocumented)

    def __init__(self):
        self._sessions = {}

    def login(self, username, password):
        """Authenticate user and create session."""
        # Simplified auth (no real DB lookup)
        token = hashlib.sha256(f"{username}:{uuid.uuid4()}".encode()).hexdigest()
        self._sessions[token] = {
            "username": username,
            "created_at": time.time(),
            "expires_at": time.time() + self.TOKEN_EXPIRY,
        }
        return {"token": token, "expires_in": self.TOKEN_EXPIRY}

    def validate_token(self, token):
        """Validate a session token.

        BUG: Accepts expired tokens within GRACE_PERIOD (5 min).
        This is undocumented behavior that downstream code relies on.
        """
        session = self._sessions.get(token)
        if not session:
            return {"valid": False, "error": "unknown_token"}

        now = time.time()
        expires_at = session["expires_at"]

        if now <= expires_at:
            return {"valid": True, "username": session["username"]}
        elif now <= expires_at + self.GRACE_PERIOD:
            # Undocumented grace period - expired but still accepted
            return {"valid": True, "username": session["username"], "grace": True}
        else:
            return {"valid": False, "error": "token_expired"}

    def logout(self, token):
        """Invalidate session."""
        if token in self._sessions:
            del self._sessions[token]
            return True
        return False
