"""Date utilities with timezone bug."""

from datetime import datetime


def format_date(dt=None):
    """Format a date for display.

    BUG: Uses system timezone instead of UTC.
    datetime.now() returns local time, not UTC.
    """
    if dt is None:
        dt = datetime.now()  # BUG: should be datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def parse_date(date_str):
    """Parse a date string."""
    return datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")


def days_between(date1, date2):
    """Calculate days between two dates."""
    delta = date2 - date1
    return abs(delta.days)
