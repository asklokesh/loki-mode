"""Audit trail."""
import time


class AuditLog:
    def __init__(self, clock=time.time):
        self._clock = clock
        self.entries = []

    def record(self, actor, action):
        self.entries.append((self._clock(), actor, action))
