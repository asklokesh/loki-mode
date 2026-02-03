"""
Progressive Disclosure Layers for Loki Mode Memory System

This module implements a 3-layer progressive disclosure system for efficient
memory retrieval:

Layer 1 - Index (~100 tokens): Topic summaries and relevance scores
Layer 2 - Timeline (~500 tokens): Recent actions and key decisions
Layer 3 - Full Memories (variable): Complete memory content on demand

The system optimizes context window usage by loading only the minimum
amount of memory data needed to answer a query.
"""

from .index_layer import IndexLayer, Topic
from .timeline_layer import TimelineLayer
from .loader import ProgressiveLoader, TokenMetrics

__all__ = [
    "IndexLayer",
    "Topic",
    "TimelineLayer",
    "ProgressiveLoader",
    "TokenMetrics",
]
