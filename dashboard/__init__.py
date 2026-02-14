"""
Loki Mode Dashboard Backend

FastAPI-based dashboard for managing Loki Mode projects, tasks, and agents.

Modules:
    control: Session control API (start/stop/pause/resume)
"""

__version__ = "5.42.1"

# Expose the control app for easy import
try:
    from .control import app as control_app
except ImportError:
    # FastAPI not installed, control module not available
    control_app = None

__all__ = ["control_app", "__version__"]
