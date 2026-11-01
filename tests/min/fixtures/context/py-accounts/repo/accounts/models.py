"""Data classes."""
from dataclasses import dataclass


@dataclass
class User:
    id: int
    email: str
    name: str
