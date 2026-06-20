"""Cross-project memory index -- discovers and indexes project memory stores.

Scans configured directories for projects containing .loki/memory/ and
builds a unified index with memory statistics per project.
"""

import json
import os
import tempfile
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
                        'discovered_at': datetime.now(timezone.utc).isoformat(),
                    })
        return projects

    @staticmethod
    def _count_episodes(episodic_dir):
        """Count episode files in an episodic store.

        Episodes are persisted by the storage layer under date subdirectories
        (episodic/{YYYY-MM-DD}/task-*.json), not directly under episodic/. A
        non-recursive episodic/*.json glob therefore reported 0 for every real
        store. Walk recursively and skip the per-directory index.json sidecars.
        """
        if not episodic_dir.exists():
            return 0
        return sum(
            1
            for f in episodic_dir.rglob('*.json')
            if f.name != 'index.json'
        )

    @staticmethod
    def _count_patterns(semantic_dir):
        """Count semantic patterns in a semantic store.

        Production stores all patterns as a list inside a single
        semantic/patterns.json, so a semantic/*.json file glob counted 1 (the
        container) regardless of how many patterns it held. Count the entries
        in patterns.json when present, and add any other *.json pattern files
        (legacy one-file-per-pattern layout) so both shapes are counted.
        """
        if not semantic_dir.exists():
            return 0
        count = 0
        patterns_file = semantic_dir / 'patterns.json'
        if patterns_file.exists():
            try:
                data = json.loads(patterns_file.read_text())
                if isinstance(data, dict):
                    patterns = data.get('patterns', [])
                    if isinstance(patterns, list):
                        count += len(patterns)
                elif isinstance(data, list):
                    count += len(data)
            except (json.JSONDecodeError, OSError, ValueError):
                pass
        # Count legacy per-pattern files, excluding known container files.
        for f in semantic_dir.glob('*.json'):
            if f.name in ('patterns.json', 'anti-patterns.json'):
                continue
            count += 1
        return count

    def build_index(self):
        """Build a cross-project index with memory statistics.

        Returns:
            Index dict with projects list and aggregate counts
        """
        projects = self.discover_projects()
        index = {
            'projects': [],
            'built_at': datetime.now(timezone.utc).isoformat(),
            'total_episodes': 0,
            'total_patterns': 0,
            'total_skills': 0,
        }

        for project in projects:
            memory_dir = Path(project['memory_dir'])
            episodic_dir = memory_dir / 'episodic'
            semantic_dir = memory_dir / 'semantic'
            skills_dir = memory_dir / 'skills'

            episodic_count = self._count_episodes(episodic_dir)
            semantic_count = self._count_patterns(semantic_dir)
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
        """Save index to disk atomically.

        Writes to a temp file in the destination directory then os.replace()s
        it over the target, so a crash or a concurrent load_index() never sees
        a truncated/torn file (the previous direct open('w') truncated in place
        before the new bytes landed).
        """
        if self._index is None:
            return
        self.index_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=str(self.index_file.parent), suffix='.tmp'
        )
        try:
            with os.fdopen(tmp_fd, 'w') as f:
                json.dump(self._index, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, str(self.index_file))
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

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
