"""Organization Knowledge Graph - Cross-project pattern aggregation.

Extracts patterns from multiple project memory stores and builds an
entity-relationship graph for cross-project knowledge sharing.

Storage: ~/.loki/knowledge/
  patterns.jsonl  - Cross-project semantic patterns
  graph.json      - Org knowledge graph: per repo services, CODEOWNERS rules and
                    decision docs (ingest_repo / merge_repo), cited by org_context
"""

import contextlib
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime, timezone

try:
    import fcntl  # POSIX-only; absent on Windows.
    _HAS_FCNTL = True
except ImportError:  # pragma: no cover - non-POSIX fallback
    fcntl = None
    _HAS_FCNTL = False

logger = logging.getLogger(__name__)


class OrganizationKnowledgeGraph:
    """Aggregates patterns and knowledge across multiple projects."""

    def __init__(self, knowledge_dir=None):
        self.knowledge_dir = Path(knowledge_dir or os.environ.get('LOKI_KNOWLEDGE_DIR') or os.path.expanduser('~/.loki/knowledge'))
        self.patterns_file = self.knowledge_dir / 'patterns.jsonl'
        self.graph_file = self.knowledge_dir / 'graph.json'
        self.lock_file = self.knowledge_dir / 'graph.lock'
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
                    pattern['_extracted_at'] = datetime.now(timezone.utc).isoformat()
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
        """Save patterns to the knowledge store (appends to JSONL).

        The append is guarded by an exclusive flock and a single flushed
        write so concurrent writers cannot interleave partial lines.
        stdio buffering breaks O_APPEND atomicity and a record longer
        than PIPE_BUF can split mid-line under concurrency, so we both
        hold the lock and emit one contiguous buffer before unlocking.
        """
        self.ensure_dir()
        # Serialize first so a serialization error cannot leave a partial
        # line on disk while the lock is held.
        buffer = "".join(json.dumps(p) + "\n" for p in patterns)
        if not buffer:
            return
        with open(self.patterns_file, 'a') as f:
            if _HAS_FCNTL:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                f.write(buffer)
                f.flush()
                os.fsync(f.fileno())
            finally:
                if _HAS_FCNTL:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)

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
                    # Resilient: skip the bad row but surface it so silent
                    # data loss (e.g. a torn legacy line) is observable.
                    logger.warning(
                        "knowledge_graph: dropped unparseable patterns.jsonl line: %.120r",
                        line,
                    )
                    continue
                if len(patterns) >= limit:
                    break
        return patterns

    @contextlib.contextmanager
    def _graph_lock(self):
        self.ensure_dir()
        with open(self.lock_file, 'a') as lf:
            if _HAS_FCNTL:
                fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if _HAS_FCNTL:
                    fcntl.flock(lf.fileno(), fcntl.LOCK_UN)

    def _write_graph(self):
        tmp = self.graph_file.with_name(self.graph_file.name + '.tmp')
        with open(tmp, 'w') as f:
            json.dump(self._graph, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.graph_file)

    def save_graph(self):
        """Persist the graph atomically (tmp file + os.replace under a flock)."""
        if self._graph is None:
            return
        with self._graph_lock():
            self._write_graph()

    def load_graph(self):
        """Load graph from disk; a missing or malformed file yields None."""
        try:
            with open(self.graph_file) as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        self._graph = data
        return self._graph

    _STOPWORDS = {
        'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'with', 'without',
        'is', 'are', 'be', 'up', 'on', 'in', 'by', 'not', 'make', 'choose',
        'store', 'how', 'do', 'i', 'we', 'my', 'our', 'this', 'that',
    }

    @classmethod
    def _tokenize(cls, text):
        """Lowercase, split on non-alphanumerics, drop stopwords + 1-2 char tokens."""
        import re
        toks = re.split(r'[^a-z0-9]+', str(text or '').lower())
        return {t for t in toks if len(t) > 2 and t not in cls._STOPWORDS}

    def query_patterns(self, query, max_results=10):
        """Keyword search across stored patterns.

        Scores by token overlap between the query and each pattern's
        name/pattern/description/category fields. Token overlap (not
        whole-string substring) lets natural-language goals like "make
        the charge endpoint safe to retry" match a pattern named
        "idempotency-key-on-charge". A full-string substring hit still
        gets a bonus, preserving prior behavior for exact queries.

        Searches 'name', 'pattern', 'description', and 'category' for
        compatibility with both simple dicts and the SemanticPattern schema.
        """
        patterns = self.load_patterns(limit=1000)
        query_lower = query.lower()
        query_tokens = self._tokenize(query)
        scored = []
        # Per-field weight applied to each overlapping token.
        fields = (('name', 3), ('pattern', 3), ('category', 2), ('description', 1))
        for p in patterns:
            score = 0
            for field, weight in fields:
                value = p.get(field, '')
                if not value:
                    continue
                # Coerce non-string field values (a hand-edited or
                # future-schema JSONL row could store a list/int) so we
                # never crash on .lower() in the live retrieval path.
                value_lower = str(value).lower()
                # Whole-query substring bonus (preserves exact-match behavior).
                if query_lower and query_lower in value_lower:
                    score += weight
                # Token-overlap scoring (enables NL-goal retrieval).
                overlap = query_tokens & self._tokenize(value)
                score += weight * len(overlap)
            if score > 0:
                scored.append((score, p))
        scored.sort(key=lambda x: -x[0])
        return [p for _, p in scored[:max_results]]

    # ------------------------------------------------------------------
    # Org knowledge: services, owners and decisions read from repo files.
    # Every node and edge carries repo + source {path, line} so a consumer
    # of the graph can cite the file it came from. Stdlib only, no network.
    # ------------------------------------------------------------------

    _MAX_MANIFEST_BYTES = 256 * 1024
    _MAX_DECISION_FILES = 200
    _MAX_DECISION_BYTES = 64 * 1024
    _MANIFEST_PARENTS = ('', 'packages', 'services', 'apps')
    _DECISION_DIRS = ('docs/adr', 'docs/adrs', 'docs/decisions', 'doc/adr', 'adr',
                      'docs/architecture/decisions')
    _OWNER_FILES = ('.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS')

    @staticmethod
    def _git(repo_dir, *args):
        try:
            r = subprocess.run(['git', '-C', str(repo_dir)] + list(args),
                               capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return ''
        return r.stdout.strip() if r.returncode == 0 else ''

    @classmethod
    def _repo_id(cls, repo_dir):
        url = cls._git(repo_dir, 'config', '--get', 'remote.origin.url')
        if url:
            url = re.sub(r'\.git$', '', url.rstrip('/'))
            parts = [x for x in re.split(r'[/:]', url) if x]
            if len(parts) >= 2:
                return parts[-2] + '/' + parts[-1]
        return Path(repo_dir).resolve().name

    @staticmethod
    def _read(repo_dir, rel, limit):
        """Read a repo file as text; refuse symlinks and paths outside the repo."""
        path = Path(repo_dir) / rel
        try:
            if path.is_symlink() or not path.is_file():
                return None
            root = Path(repo_dir).resolve()
            if root not in path.resolve().parents:
                return None
            with open(path, 'rb') as f:
                return f.read(limit).decode('utf-8', 'replace')
        except OSError:
            return None

    @staticmethod
    def _norm_py(name):
        return re.split(r'[<>=!~;\[ ]', name.strip().lower().replace('_', '-'), 1)[0]

    @staticmethod
    def _line_of(lines, pattern, start=0):
        rx = re.compile(pattern)
        for i in range(start, len(lines)):
            if rx.search(lines[i]):
                return i + 1
        return None

    def _parse_package_json(self, text):
        try:
            data = json.loads(text)
        except ValueError:
            return None
        if not isinstance(data, dict) or not isinstance(data.get('name'), str):
            return None
        lines = text.splitlines()
        deps, dep_lines = [], {}
        for key in ('dependencies', 'devDependencies', 'peerDependencies'):
            section = data.get(key)
            if not isinstance(section, dict):
                continue
            start = (self._line_of(lines, r'"%s"\s*:' % key) or 1) - 1
            for dep in section:
                if dep not in dep_lines:
                    deps.append(dep)
                    dep_lines[dep] = self._line_of(lines, r'"%s"\s*:' % re.escape(dep), start) or start + 1
        return data['name'], self._line_of(lines, r'"name"\s*:') or 1, deps, dep_lines

    def _parse_pyproject(self, text):
        lines = text.splitlines()
        name, name_line, section = None, 1, ''
        deps, dep_lines = [], {}

        def add(raw, ln):
            dep = self._norm_py(raw)
            if dep and dep != 'python' and dep not in dep_lines:
                deps.append(dep)
                dep_lines[dep] = ln

        in_array = False
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if in_array:
                for m in re.finditer(r'["\']([^"\']+)["\']', stripped.split('#')[0]):
                    add(m.group(1), i)
                if ']' in stripped.split('#')[0]:
                    in_array = False
                continue
            m = re.match(r'^\[([^\]]+)\]\s*$', stripped)
            if m:
                section = m.group(1).strip()
                continue
            if section in ('project', 'tool.poetry'):
                m = re.match(r'^name\s*=\s*["\']([^"\']+)["\']', stripped)
                if m and name is None:
                    name, name_line = self._norm_py(m.group(1)), i
                if section == 'project' and re.match(r'^dependencies\s*=\s*\[', stripped):
                    body = stripped.split('=', 1)[1].split('#')[0]
                    for mm in re.finditer(r'["\']([^"\']+)["\']', body):
                        add(mm.group(1), i)
                    in_array = ']' not in body
            elif section == 'tool.poetry.dependencies':
                m = re.match(r'^([A-Za-z0-9_.\-]+)\s*=', stripped)
                if m:
                    add(m.group(1), i)
        if not name:
            return None
        return name, name_line, deps, dep_lines

    def _parse_go_mod(self, text):
        name, name_line, deps, dep_lines, in_block = None, 1, [], {}, False
        for i, line in enumerate(text.splitlines(), 1):
            stripped = line.split('//')[0].strip()
            m = re.match(r'^module\s+(\S+)', stripped)
            if m and name is None:
                name, name_line = m.group(1).strip('"'), i
                continue
            if re.match(r'^require\s*\(', stripped):
                in_block = True
                continue
            if in_block and stripped == ')':
                in_block = False
                continue
            m = re.match(r'^require\s+(\S+)\s+\S+', stripped) or (in_block and re.match(r'^(\S+)\s+\S+', stripped))
            if m and m.group(1) not in dep_lines:
                deps.append(m.group(1))
                dep_lines[m.group(1)] = i
        if not name:
            return None
        return name, name_line, deps, dep_lines

    def _ingest_services(self, repo_dir, repo):
        nodes = []
        root = Path(repo_dir)
        dirs = []
        for parent in self._MANIFEST_PARENTS:
            if parent == '':
                dirs.append('')
                continue
            base = root / parent
            if base.is_dir() and not base.is_symlink():
                try:
                    dirs.extend(parent + '/' + c.name for c in sorted(base.iterdir()) if c.is_dir() and not c.is_symlink())
                except OSError:
                    pass
        parsers = (('package.json', self._parse_package_json),
                   ('pyproject.toml', self._parse_pyproject),
                   ('go.mod', self._parse_go_mod))
        for d in dirs:
            for fname, parse in parsers:
                rel = (d + '/' + fname) if d else fname
                text = self._read(repo_dir, rel, self._MAX_MANIFEST_BYTES)
                parsed = parse(text) if text else None
                if not parsed:
                    continue
                name, line, deps, dep_lines = parsed
                nodes.append({'id': 'service:' + name, 'type': 'service', 'name': name,
                              'deps': deps, 'deps_lines': dep_lines, 'repo': repo,
                              'source': {'path': rel, 'line': line}})
        return nodes

    def _ingest_owners(self, repo_dir, repo):
        for rel in self._OWNER_FILES:
            text = self._read(repo_dir, rel, self._MAX_MANIFEST_BYTES)
            if text is None:
                continue
            edges = []
            for i, line in enumerate(text.splitlines(), 1):
                stripped = line.split('#')[0].strip()
                parts = stripped.split()
                if len(parts) < 2:
                    continue
                edges.append({'type': 'owns', 'pattern': parts[0], 'owners': parts[1:],
                              'repo': repo, 'source': {'path': rel, 'line': i}})
            return edges
        return []

    def _ingest_decisions(self, repo_dir, repo):
        root = Path(repo_dir)
        files = []
        for d in self._DECISION_DIRS:
            base = root / d
            if not base.is_dir() or base.is_symlink():
                continue
            try:
                files.extend(sorted(base.rglob('*.md')))
            except OSError:
                continue
        nodes, seen = [], set()
        for path in files:
            if len(nodes) >= self._MAX_DECISION_FILES:
                break
            rel = path.relative_to(root).as_posix()
            if rel in seen:
                continue
            seen.add(rel)
            text = self._read(repo_dir, rel, self._MAX_DECISION_BYTES)
            if not text:
                continue
            lines = text.splitlines()
            title, title_line = path.stem, 1
            for i, line in enumerate(lines, 1):
                if line.startswith('# '):
                    title, title_line = line[2:].strip(), i
                    break
            status = ''
            for i, line in enumerate(lines):
                m = re.match(r'^\W*status\W*:\s*(.+)$', line.strip(), re.I)
                if m:
                    status = m.group(1).strip(' *_')
                    break
                if re.match(r'^##\s+status\s*$', line.strip(), re.I):
                    for nxt in lines[i + 1:]:
                        if nxt.strip():
                            status = nxt.strip(' *_')
                            break
                    break
            body = None
            for i, line in enumerate(lines):
                if re.match(r'^##\s+decision\s*$', line.strip(), re.I):
                    body = lines[i + 1:]
                    break
            if body is None:
                body = lines[title_line:]
            chunk = []
            for line in body:
                if line.startswith('## '):
                    break
                chunk.append(line)
            summary = re.sub(r'\s+', ' ', ' '.join(chunk)).strip()[:300]
            nodes.append({'id': 'decision:%s:%s' % (repo, rel), 'type': 'decision',
                          'title': title, 'status': status, 'summary': summary,
                          'repo': repo, 'source': {'path': rel, 'line': title_line}})
        return nodes

    def ingest_repo(self, repo_dir):
        """Read services, CODEOWNERS rules and decision docs from one repo."""
        repo = self._repo_id(repo_dir)
        nodes = self._ingest_services(repo_dir, repo) + self._ingest_decisions(repo_dir, repo)
        return {'repo': repo, 'nodes': nodes, 'edges': self._ingest_owners(repo_dir, repo)}

    def merge_repo(self, repo_dir):
        """Replace this repo's facts in graph.json with a fresh ingest (idempotent)."""
        res = self.ingest_repo(repo_dir)
        repo = res['repo']
        with self._graph_lock():
            graph = self.load_graph()
            if not graph or not isinstance(graph.get('repos'), dict):
                graph = {'version': 2, 'repos': {}, 'nodes': [], 'edges': []}
            graph['version'] = 2
            graph['nodes'] = [n for n in graph.get('nodes', []) if n.get('repo') != repo] + res['nodes']
            graph['edges'] = [e for e in graph.get('edges', []) if e.get('repo') != repo] + res['edges']
            graph['repos'][repo] = {'path': str(Path(repo_dir).resolve()),
                                    'ingested_at': datetime.now(timezone.utc).isoformat(),
                                    'head_sha': self._git(repo_dir, 'rev-parse', 'HEAD')}
            self._graph = graph
            self._write_graph()
        return {'repo': repo,
                'services': sum(1 for n in res['nodes'] if n['type'] == 'service'),
                'owners': len(res['edges']),
                'decisions': sum(1 for n in res['nodes'] if n['type'] == 'decision'),
                'repos': len(graph['repos'])}

    @staticmethod
    def _cite(item):
        src = item.get('source') or {}
        return ' [%s %s:%s]' % (item.get('repo', '?'), src.get('path', '?'), src.get('line', 1))

    @staticmethod
    def _clean(text):
        return re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f]', ' ', str(text))).strip()

    def org_context(self, task, repo_dir, max_bytes=1500):
        """Cited plain lines: this repo's services, owners, consumers, providers, decisions."""
        graph = self.load_graph()
        if not graph:
            return ''
        repo = self._repo_id(repo_dir)
        nodes, edges = graph.get('nodes', []), graph.get('edges', [])
        mine = [n for n in nodes if n.get('type') == 'service' and n.get('repo') == repo]
        others = [n for n in nodes if n.get('type') == 'service' and n.get('repo') != repo]
        task_tokens = self._tokenize(task)
        lines = []
        for n in mine:
            lines.append('service %s (this repo)%s' % (n['name'], self._cite(n)))
        rules = []
        for e in edges:
            if e.get('type') != 'owns' or e.get('repo') != repo:
                continue
            overlap = len(self._tokenize(e.get('pattern', '')) & task_tokens)
            if overlap > 0:
                rules.append((0, -overlap, e.get('source', {}).get('line', 0), e))
            elif e.get('pattern') == '*':
                rules.append((1, 0, e.get('source', {}).get('line', 0), e))
        rules.sort(key=lambda r: r[:3])
        for _, _, _, e in rules[:4]:
            lines.append('owner %s: %s%s' % (e['pattern'], ' '.join(e['owners']), self._cite(e)))
        my_names = {n['name'] for n in mine}
        consumers = []
        for o in others:
            for dep in o.get('deps', []):
                if dep in my_names:
                    ln = (o.get('deps_lines') or {}).get(dep, o['source']['line'])
                    consumers.append('consumer: %s in %s depends on %s [%s %s:%s]' % (
                        o['name'], o['repo'], dep, o['repo'], o['source']['path'], ln))
        lines.extend(consumers[:5])
        providers = []
        my_deps = {d for n in mine for d in n.get('deps', [])}
        for o in others:
            if o['name'] in my_deps:
                star = [e for e in edges if e.get('type') == 'owns' and e.get('repo') == o['repo']
                        and e.get('pattern') == '*']
                owners = ' '.join(star[0]['owners']) if star else 'unknown'
                providers.append('provider: %s from %s, owners %s%s' % (o['name'], o['repo'], owners, self._cite(o)))
        lines.extend(providers[:3])
        scored = []
        for n in nodes:
            if n.get('type') != 'decision':
                continue
            score = 2 * len(task_tokens & self._tokenize(n.get('title', ''))) + \
                len(task_tokens & self._tokenize(n.get('summary', '')))
            if score > 0:
                scored.append((-score, n.get('id', ''), n))
        scored.sort(key=lambda r: r[:2])
        for _, _, n in scored[:3]:
            lines.append('decision "%s" (%s): %s%s' % (n['title'], n.get('status') or 'no status',
                                                         n.get('summary', ''), self._cite(n)))
        out, used = [], 0
        for line in lines:
            line = self._clean(line)
            cost = len(line.encode('utf-8')) + 1
            if used + cost > max_bytes:
                break
            out.append(line)
            used += cost
        return '\n'.join(out)


def main(argv):
    usage = ('usage: knowledge_graph.py ingest <path>... | brief --repo D --task T | '
             'ask <question> [--repo D]')
    if not argv:
        print(usage, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    kg = OrganizationKnowledgeGraph()
    if cmd == 'ingest':
        paths = rest or ['.']
        for p in paths:
            if not os.path.isdir(p):
                print('Not a directory: %s' % p, file=sys.stderr)
                return 1
            r = kg.merge_repo(p)
            print('Ingested %s: %d services, %d owner rules, %d decisions (graph: %d repos) -> %s' % (
                r['repo'], r['services'], r['owners'], r['decisions'], r['repos'], kg.graph_file))
        return 0
    opts, words, i = {}, [], 0
    while i < len(rest):
        if rest[i] in ('--repo', '--task') and i + 1 < len(rest):
            opts[rest[i]] = rest[i + 1]
            i += 2
        else:
            words.append(rest[i])
            i += 1
    repo = opts.get('--repo', '.')
    if cmd == 'brief':
        # Never fail a run: every error yields an empty block.
        try:
            kg.merge_repo(repo)
        except Exception as e:  # noqa: BLE001
            logger.warning('knowledge_graph: ingest failed: %s', e)
        try:
            out = kg.org_context(opts.get('--task', ''), repo)
        except Exception as e:  # noqa: BLE001
            logger.warning('knowledge_graph: context failed: %s', e)
            out = ''
        if out:
            print(out)
        return 0
    if cmd == 'ask':
        if not words:
            print(usage, file=sys.stderr)
            return 2
        out = kg.org_context(' '.join(words), repo)
        print(out or 'No org knowledge found. Run: loki memory graph ingest <path>...')
        return 0
    print(usage, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
