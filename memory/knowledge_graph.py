"""Organization Knowledge Graph - Cross-project pattern aggregation.

Extracts patterns from multiple project memory stores and builds an
entity-relationship graph for cross-project knowledge sharing.

Storage: ~/.loki/knowledge/
  patterns.jsonl  - Cross-project semantic patterns
  graph.json      - Entity-relationship graph (projects, patterns, skills)
"""

import json
import os
from pathlib import Path
from datetime import datetime, timezone


class OrganizationKnowledgeGraph:
    """Aggregates patterns and knowledge across multiple projects."""

    def __init__(self, knowledge_dir=None):
        self.knowledge_dir = Path(knowledge_dir or os.path.expanduser('~/.loki/knowledge'))
        self.patterns_file = self.knowledge_dir / 'patterns.jsonl'
        self.graph_file = self.knowledge_dir / 'graph.json'
        self._graph = None

    def ensure_dir(self):
        self.knowledge_dir.mkdir(parents=True, exist_ok=True)

    def extract_patterns(self, project_dirs):
        """Extract semantic patterns from multiple project memory stores.

        Args:
            project_dirs: List of Path objects pointing to project roots

        Returns:
            List of extracted pattern dicts
        """
        all_patterns = []
        for project_dir in project_dirs:
            project_dir = Path(project_dir)
            memory_dir = project_dir / '.loki' / 'memory' / 'semantic'
            if not memory_dir.exists():
                continue
            for pattern_file in memory_dir.glob('*.json'):
                try:
                    with open(pattern_file) as f:
                        pattern = json.load(f)
                    pattern['_source_project'] = str(project_dir)
                    pattern['_extracted_at'] = datetime.now(timezone.utc).isoformat() + 'Z'
                    all_patterns.append(pattern)
                except (json.JSONDecodeError, IOError):
                    continue
        return all_patterns

    def deduplicate_patterns(self, patterns):
        """Remove duplicate patterns based on name/pattern and category similarity.

        Uses simple string matching (not embeddings) for dedup.
        The 'name' field is checked first, falling back to 'pattern' for
        compatibility with SemanticPattern schema.
        """
        seen = {}
        unique = []
        for p in patterns:
            # Support both 'name' (simple dict) and 'pattern' (SemanticPattern schema)
            identifier = p.get('name', p.get('pattern', ''))
            key = (identifier, p.get('category', ''))
            if key not in seen:
                seen[key] = p
                unique.append(p)
            else:
                # Merge: keep the one with more observations/usage
                existing = seen[key]
                existing_count = existing.get('observation_count', existing.get('usage_count', 0))
                new_count = p.get('observation_count', p.get('usage_count', 0))
                if new_count > existing_count:
                    seen[key] = p
                    unique = [x if (x.get('name', x.get('pattern', '')), x.get('category', '')) != key else p for x in unique]
        return unique

    def save_patterns(self, patterns):
        """Save patterns to the knowledge store (appends to JSONL)."""
        self.ensure_dir()
        with open(self.patterns_file, 'a') as f:
            for p in patterns:
                f.write(json.dumps(p) + '\n')

    def load_patterns(self, limit=100):
        """Load patterns from the knowledge store."""
        if not self.patterns_file.exists():
            return []
        patterns = []
        with open(self.patterns_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    patterns.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if len(patterns) >= limit:
                    break
        return patterns

    def build_graph(self, project_dirs):
        """Build entity-relationship graph across projects.

        Nodes: projects, patterns, skills
        Edges: project->pattern (has_pattern), pattern->pattern (similar_to)
        """
        graph = {
            'nodes': [],
            'edges': [],
            'built_at': datetime.now(timezone.utc).isoformat() + 'Z',
        }

        for project_dir in project_dirs:
            project_dir = Path(project_dir)
            project_name = project_dir.name
            graph['nodes'].append({
                'id': 'project:' + project_name,
                'type': 'project',
                'name': project_name,
                'path': str(project_dir),
            })

            # Extract patterns from this project
            memory_dir = project_dir / '.loki' / 'memory' / 'semantic'
            if memory_dir.exists():
                for pattern_file in memory_dir.glob('*.json'):
                    try:
                        with open(pattern_file) as f:
                            pattern = json.load(f)
                        identifier = pattern.get('name', pattern.get('pattern', pattern_file.stem))
                        pattern_id = 'pattern:' + identifier
                        graph['nodes'].append({
                            'id': pattern_id,
                            'type': 'pattern',
                            'name': identifier,
                            'category': pattern.get('category', ''),
                        })
                        graph['edges'].append({
                            'source': 'project:' + project_name,
                            'target': pattern_id,
                            'type': 'has_pattern',
                        })
                    except (json.JSONDecodeError, IOError):
                        continue

        self._graph = graph
        return graph

    def save_graph(self):
        """Persist the graph to disk."""
        if self._graph is None:
            return
        self.ensure_dir()
        with open(self.graph_file, 'w') as f:
            json.dump(self._graph, f, indent=2)

    def load_graph(self):
        """Load graph from disk."""
        if not self.graph_file.exists():
            return None
        with open(self.graph_file) as f:
            self._graph = json.load(f)
        return self._graph

    def query_patterns(self, query, max_results=10):
        """Simple keyword search across stored patterns.

        Searches across 'name', 'pattern', 'description', and 'category'
        fields for compatibility with both simple dicts and SemanticPattern
        schema.
        """
        patterns = self.load_patterns(limit=1000)
        query_lower = query.lower()
        scored = []
        for p in patterns:
            score = 0
            name = p.get('name', '').lower()
            pattern_text = p.get('pattern', '').lower()
            desc = p.get('description', '').lower()
            category = p.get('category', '').lower()
            if query_lower in name:
                score += 3
            if query_lower in pattern_text:
                score += 3
            if query_lower in desc:
                score += 1
            if query_lower in category:
                score += 2
            if score > 0:
                scored.append((score, p))
        scored.sort(key=lambda x: -x[0])
        return [p for _, p in scored[:max_results]]
