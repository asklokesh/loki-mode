#!/usr/bin/env python3
"""RAG context injector -- builds knowledge context for RARV prompts.

CLI usage: python3 -m memory.rag_injector --query "description" --max-tokens 2000

Reads from the organization knowledge graph and returns relevant context
for injection into the RARV prompt cycle.
"""

import argparse
import json
import re
import sys
from pathlib import Path


# Per-field hard cap so a single oversized/garbage memory entry cannot dominate
# the injected context or push real signal out of the token budget.
_MAX_FIELD_CHARS = 600

# Control characters (excluding ordinary whitespace handled separately) that
# must never reach the prompt: they can corrupt rendering or smuggle hidden
# directives. Covers C0 controls and DEL.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _sanitize_field(value, max_chars=_MAX_FIELD_CHARS):
    """Neutralize a single field from stored memory before it enters a prompt.

    Memory entries are untrusted input: a malicious or garbage pattern could
    contain prompt-injection payloads (fake instructions, fabricated section
    headers, code-fence breakers, or directives that try to override the RARV
    prompt). This collapses each field to a single safe inline line so it can
    only ever read as data, never as structure or instructions.

    Steps:
    - Coerce non-strings to str (a dict/list value would otherwise break
      formatting or interpolate unexpected structure).
    - Drop control characters (keeps the visible text intact).
    - Collapse ALL newlines/tabs/carriage-returns to single spaces so the
      field cannot add new lines, fake "### " section headers, close the
      knowledge block, or open/close a markdown code fence.
    - Defang leading structural markdown markers (#, >, -, *, backticks) so the
      field cannot pose as a heading/list/fence even after collapsing.
    - Truncate to a bounded length.
    """
    if value is None:
        return ''
    if not isinstance(value, str):
        value = str(value)
    # Remove control characters first.
    value = _CONTROL_CHARS_RE.sub('', value)
    # Collapse any vertical whitespace and tabs into single spaces. This is the
    # core injection defense: without newlines the field cannot introduce new
    # markdown structure or standalone instruction lines.
    value = re.sub(r'[\r\n\t]+', ' ', value)
    # Collapse runs of spaces left behind.
    value = re.sub(r' {2,}', ' ', value).strip()
    # Defang leading structural markdown so the field cannot masquerade as a
    # heading, blockquote, list item, or code fence.
    value = re.sub(r'^[#>\-*`]+\s*', '', value)
    # Defang markdown header markers anywhere in the (now single-line) value so
    # a collapsed payload cannot reintroduce a "### " section marker inline.
    # Backticks are neutralized too so a field cannot open/close a code fence.
    value = re.sub(r'#{1,6}\s', '', value)
    value = value.replace('`', '')
    if len(value) > max_chars:
        value = value[:max_chars].rstrip() + '...'
    return value


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
        # Support both 'name'/'pattern' and 'description' fields.
        # Every field is sanitized: memory entries are untrusted input and must
        # not be able to inject instructions or break the prompt structure.
        name = _sanitize_field(p.get('name', p.get('pattern', 'Unknown Pattern')))
        desc = _sanitize_field(p.get('description', p.get('correct_approach', '')))
        category = _sanitize_field(p.get('category', ''))
        source_raw = p.get('_source_project', '')
        # Path().name strips any directory traversal; sanitize the basename too.
        source = _sanitize_field(Path(str(source_raw)).name) if source_raw else ''

        # name may be empty after sanitization (e.g. a field that was only
        # markdown markers); fall back so the heading is never blank.
        if not name:
            name = 'Unknown Pattern'

        section = '### ' + name
        if category:
            section += ' (' + category + ')'
        section += '\n'
        if desc:
            section += desc + '\n'
        if source:
            section += '_Source: ' + source + '_\n'

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
