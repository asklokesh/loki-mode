#!/usr/bin/env python3
"""RAG context injector -- builds knowledge context for RARV prompts.

CLI usage: python3 -m memory.rag_injector --query "description" --max-tokens 2000

Reads from the organization knowledge graph and returns relevant context
for injection into the RARV prompt cycle.
"""

import argparse
import json
import sys
from pathlib import Path


def build_rag_context(query, max_tokens=2000, knowledge_dir=None):
    """Build RAG context from the knowledge graph.

    Args:
        query: Search query (usually PRD summary or task description)
        max_tokens: Maximum approximate tokens (chars / 4)
        knowledge_dir: Override knowledge directory

    Returns:
        Formatted context string for prompt injection, or empty string
        if no matching patterns are found.
    """
    from .knowledge_graph import OrganizationKnowledgeGraph

    kg = OrganizationKnowledgeGraph(knowledge_dir)
    patterns = kg.query_patterns(query, max_results=10)

    if not patterns:
        return ''

    max_chars = max_tokens * 4  # Rough chars-to-tokens ratio

    sections = []
    total_chars = 0

    for p in patterns:
        # Support both 'name'/'pattern' and 'description' fields
        name = p.get('name', p.get('pattern', 'Unknown Pattern'))
        desc = p.get('description', p.get('correct_approach', ''))
        category = p.get('category', '')
        source = p.get('_source_project', '')

        section = '### ' + name
        if category:
            section += ' (' + category + ')'
        section += '\n'
        if desc:
            section += desc + '\n'
        if source:
            section += '_Source: ' + Path(source).name + '_\n'

        if total_chars + len(section) > max_chars:
            break
        sections.append(section)
        total_chars += len(section)

    if not sections:
        return ''

    return 'The following patterns were found in the organization knowledge base:\n\n' + '\n'.join(sections)


def main():
    parser = argparse.ArgumentParser(description='RAG context injector for RARV prompts')
    parser.add_argument('--query', required=True, help='Search query')
    parser.add_argument('--max-tokens', type=int, default=2000, help='Max tokens for context')
    parser.add_argument('--knowledge-dir', help='Override knowledge directory')
    args = parser.parse_args()

    context = build_rag_context(args.query, args.max_tokens, args.knowledge_dir)
    if context:
        print(context)


if __name__ == '__main__':
    main()
