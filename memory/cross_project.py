"""Cross-project memory index -- discovers and indexes project memory stores.

Scans configured directories for projects containing .loki/memory/ and
builds a unified index with memory statistics per project.
"""

import json
import os
from pathlib import Path
from datetime import datetime, timezone


class CrossProjectIndex:
    """Discovers and indexes memory across multiple projects."""

    def __init__(self, search_dirs=None, index_file=None):
        self.search_dirs = search_dirs or [
            Path.home() / 'git',
            Path.home() / 'projects',
            Path.home() / 'src',
        ]
        self.index_file = Path(index_file or os.path.expanduser('~/.loki/knowledge/project-index.json'))
        self._index = None

    def discover_projects(self):
        """Find all projects with .loki/memory/ directories.

        Searches immediate subdirectories (depth=1) of each search dir.

        Returns:
            List of project info dicts with path, name, memory_dir, discovered_at
        """
        projects = []
        for search_dir in self.search_dirs:
            search_dir = Path(search_dir)
            if not search_dir.exists():
                continue
            # Look for .loki/memory in immediate subdirectories (depth=1)
            for child in search_dir.iterdir():
                if not child.is_dir():
                    continue
                memory_dir = child / '.loki' / 'memory'
                if memory_dir.exists():
                    projects.append({
                        'path': str(child),
                        'name': child.name,
                        'memory_dir': str(memory_dir),
                        'discovered_at': datetime.now(timezone.utc).isoformat() + 'Z',
                    })
        return projects

    def build_index(self):
        """Build a cross-project index with memory statistics.

        Returns:
            Index dict with projects list and aggregate counts
        """
        projects = self.discover_projects()
        index = {
            'projects': [],
            'built_at': datetime.now(timezone.utc).isoformat() + 'Z',
            'total_episodes': 0,
            'total_patterns': 0,
            'total_skills': 0,
        }

        for project in projects:
            memory_dir = Path(project['memory_dir'])
            episodic_dir = memory_dir / 'episodic'
            semantic_dir = memory_dir / 'semantic'
            skills_dir = memory_dir / 'skills'

            episodic_count = len(list(episodic_dir.glob('*.json'))) if episodic_dir.exists() else 0
            semantic_count = len(list(semantic_dir.glob('*.json'))) if semantic_dir.exists() else 0
            skills_count = len(list(skills_dir.glob('*.json'))) if skills_dir.exists() else 0

            project['episodic_count'] = episodic_count
            project['semantic_count'] = semantic_count
            project['skills_count'] = skills_count
            index['projects'].append(project)
            index['total_episodes'] += episodic_count
            index['total_patterns'] += semantic_count
            index['total_skills'] += skills_count

        self._index = index
        return index

    def save_index(self):
        """Save index to disk."""
        if self._index is None:
            return
        self.index_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.index_file, 'w') as f:
            json.dump(self._index, f, indent=2)

    def load_index(self):
        """Load index from disk."""
        if not self.index_file.exists():
            return None
        with open(self.index_file) as f:
            self._index = json.load(f)
        return self._index

    def get_project_dirs(self):
        """Return list of discovered project directories as Path objects."""
        if self._index is None:
            self.build_index()
        return [Path(p['path']) for p in self._index.get('projects', [])]
