"""Tests for organization knowledge graph, cross-project index, and RAG injector."""
import json
import os
import tempfile
import shutil
from pathlib import Path

import unittest

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from memory.knowledge_graph import OrganizationKnowledgeGraph
from memory.cross_project import CrossProjectIndex
from memory.rag_injector import build_rag_context


class TestOrganizationKnowledgeGraph(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.knowledge_dir = os.path.join(self.tmpdir, 'knowledge')
        self.kg = OrganizationKnowledgeGraph(knowledge_dir=self.knowledge_dir)

        # Create mock project directories with memory
        self.project1 = os.path.join(self.tmpdir, 'project1')
        self.project2 = os.path.join(self.tmpdir, 'project2')
        for proj in [self.project1, self.project2]:
            semantic_dir = os.path.join(proj, '.loki', 'memory', 'semantic')
            os.makedirs(semantic_dir, exist_ok=True)

        # Write sample patterns
        pattern1 = {'name': 'error-retry', 'category': 'resilience', 'description': 'Retry with exponential backoff', 'observation_count': 5}
        pattern2 = {'name': 'cache-invalidation', 'category': 'performance', 'description': 'TTL-based cache invalidation', 'observation_count': 3}
        pattern3 = {'name': 'error-retry', 'category': 'resilience', 'description': 'Retry with jitter', 'observation_count': 8}

        with open(os.path.join(self.project1, '.loki', 'memory', 'semantic', 'p1.json'), 'w') as f:
            json.dump(pattern1, f)
        with open(os.path.join(self.project1, '.loki', 'memory', 'semantic', 'p2.json'), 'w') as f:
            json.dump(pattern2, f)
        with open(os.path.join(self.project2, '.loki', 'memory', 'semantic', 'p3.json'), 'w') as f:
            json.dump(pattern3, f)

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_extract_patterns(self):
        patterns = self.kg.extract_patterns([self.project1, self.project2])
        self.assertEqual(len(patterns), 3)
        self.assertTrue(all('_source_project' in p for p in patterns))
        self.assertTrue(all('_extracted_at' in p for p in patterns))

    def test_extract_patterns_skips_missing_dirs(self):
        patterns = self.kg.extract_patterns(['/nonexistent/path'])
        self.assertEqual(len(patterns), 0)

    def test_deduplicate_patterns(self):
        patterns = self.kg.extract_patterns([self.project1, self.project2])
        deduped = self.kg.deduplicate_patterns(patterns)
        self.assertEqual(len(deduped), 2)  # error-retry deduped
        # Should keep the one with higher observation_count (8 > 5)
        error_retry = [p for p in deduped if p['name'] == 'error-retry'][0]
        self.assertEqual(error_retry['observation_count'], 8)

    def test_deduplicate_preserves_unique(self):
        patterns = [
            {'name': 'a', 'category': 'x', 'observation_count': 1},
            {'name': 'b', 'category': 'y', 'observation_count': 2},
        ]
        deduped = self.kg.deduplicate_patterns(patterns)
        self.assertEqual(len(deduped), 2)

    def test_save_and_load_patterns(self):
        patterns = [{'name': 'test', 'description': 'test pattern'}]
        self.kg.save_patterns(patterns)
        loaded = self.kg.load_patterns()
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]['name'], 'test')

    def test_load_patterns_empty_file(self):
        self.kg.ensure_dir()
        # Create empty patterns file
        with open(self.kg.patterns_file, 'w') as f:
            f.write('')
        loaded = self.kg.load_patterns()
        self.assertEqual(len(loaded), 0)

    def test_load_patterns_respects_limit(self):
        patterns = [{'name': f'p{i}', 'description': f'pattern {i}'} for i in range(20)]
        self.kg.save_patterns(patterns)
        loaded = self.kg.load_patterns(limit=5)
        self.assertEqual(len(loaded), 5)

    def test_load_patterns_nonexistent(self):
        loaded = self.kg.load_patterns()
        self.assertEqual(len(loaded), 0)

    def test_query_patterns(self):
        patterns = [
            {'name': 'error-retry', 'description': 'Retry logic', 'category': 'resilience'},
            {'name': 'cache-ttl', 'description': 'Cache with TTL', 'category': 'performance'},
        ]
        self.kg.save_patterns(patterns)
        results = self.kg.query_patterns('retry')
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]['name'], 'error-retry')

    def test_query_patterns_by_category(self):
        patterns = [
            {'name': 'error-retry', 'description': 'Retry logic', 'category': 'resilience'},
            {'name': 'cache-ttl', 'description': 'Cache with TTL', 'category': 'performance'},
        ]
        self.kg.save_patterns(patterns)
        results = self.kg.query_patterns('performance')
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]['name'], 'cache-ttl')

    def test_query_patterns_no_match(self):
        patterns = [
            {'name': 'error-retry', 'description': 'Retry logic', 'category': 'resilience'},
        ]
        self.kg.save_patterns(patterns)
        results = self.kg.query_patterns('quantum')
        self.assertEqual(len(results), 0)

    def test_build_graph(self):
        graph = self.kg.build_graph([self.project1, self.project2])
        self.assertIn('nodes', graph)
        self.assertIn('edges', graph)
        self.assertIn('built_at', graph)
        project_nodes = [n for n in graph['nodes'] if n['type'] == 'project']
        self.assertEqual(len(project_nodes), 2)
        pattern_nodes = [n for n in graph['nodes'] if n['type'] == 'pattern']
        self.assertGreater(len(pattern_nodes), 0)
        # Each pattern should have an edge from its project
        self.assertGreater(len(graph['edges']), 0)

    def test_save_and_load_graph(self):
        self.kg.build_graph([self.project1])
        self.kg.save_graph()
        self.assertTrue(self.kg.graph_file.exists())
        loaded = self.kg.load_graph()
        self.assertIsNotNone(loaded)
        self.assertIn('nodes', loaded)

    def test_save_graph_noop_without_build(self):
        # save_graph should be a no-op if graph was never built
        self.kg.save_graph()
        self.assertFalse(self.kg.graph_file.exists())

    def test_load_graph_nonexistent(self):
        result = self.kg.load_graph()
        self.assertIsNone(result)

    def test_ensure_dir_creates_directory(self):
        self.assertFalse(os.path.exists(self.knowledge_dir))
        self.kg.ensure_dir()
        self.assertTrue(os.path.isdir(self.knowledge_dir))


class TestCrossProjectIndex(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.search_dir = os.path.join(self.tmpdir, 'projects')
        os.makedirs(self.search_dir)

        # Create projects with memory
        for name in ['proj-a', 'proj-b']:
            memory_dir = os.path.join(self.search_dir, name, '.loki', 'memory')
            os.makedirs(memory_dir)
            os.makedirs(os.path.join(memory_dir, 'episodic'))
            os.makedirs(os.path.join(memory_dir, 'semantic'))
            # Write a sample file
            with open(os.path.join(memory_dir, 'semantic', 'p1.json'), 'w') as f:
                json.dump({'name': 'test'}, f)

        self.index = CrossProjectIndex(
            search_dirs=[Path(self.search_dir)],
            index_file=os.path.join(self.tmpdir, 'index.json'),
        )

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_discover_projects(self):
        projects = self.index.discover_projects()
        self.assertEqual(len(projects), 2)
        names = [p['name'] for p in projects]
        self.assertIn('proj-a', names)
        self.assertIn('proj-b', names)

    def test_discover_projects_includes_required_fields(self):
        projects = self.index.discover_projects()
        for p in projects:
            self.assertIn('path', p)
            self.assertIn('name', p)
            self.assertIn('memory_dir', p)
            self.assertIn('discovered_at', p)

    def test_discover_projects_skips_nonexistent_dirs(self):
        idx = CrossProjectIndex(
            search_dirs=[Path('/nonexistent/path')],
            index_file=os.path.join(self.tmpdir, 'idx2.json'),
        )
        projects = idx.discover_projects()
        self.assertEqual(len(projects), 0)

    def test_discover_projects_skips_dirs_without_memory(self):
        # Create a project without .loki/memory
        os.makedirs(os.path.join(self.search_dir, 'no-memory-proj'))
        projects = self.index.discover_projects()
        names = [p['name'] for p in projects]
        self.assertNotIn('no-memory-proj', names)

    def test_build_index(self):
        index = self.index.build_index()
        self.assertEqual(len(index['projects']), 2)
        self.assertGreater(index['total_patterns'], 0)
        self.assertIn('built_at', index)

    def test_build_index_counts_files(self):
        index = self.index.build_index()
        for proj in index['projects']:
            self.assertIn('episodic_count', proj)
            self.assertIn('semantic_count', proj)
            self.assertIn('skills_count', proj)

    def test_save_and_load_index(self):
        self.index.build_index()
        self.index.save_index()
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, 'index.json')))
        loaded = self.index.load_index()
        self.assertIsNotNone(loaded)
        self.assertEqual(len(loaded['projects']), 2)

    def test_load_index_nonexistent(self):
        result = self.index.load_index()
        self.assertIsNone(result)

    def test_get_project_dirs(self):
        dirs = self.index.get_project_dirs()
        self.assertEqual(len(dirs), 2)
        self.assertTrue(all(isinstance(d, Path) for d in dirs))


class TestRAGInjector(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.knowledge_dir = os.path.join(self.tmpdir, 'knowledge')
        os.makedirs(self.knowledge_dir)

        # Write patterns
        patterns_file = os.path.join(self.knowledge_dir, 'patterns.jsonl')
        with open(patterns_file, 'w') as f:
            f.write(json.dumps({'name': 'error-retry', 'description': 'Retry with backoff', 'category': 'resilience'}) + '\n')
            f.write(json.dumps({'name': 'cache-ttl', 'description': 'TTL caching', 'category': 'performance'}) + '\n')

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_build_rag_context_with_match(self):
        context = build_rag_context('retry', knowledge_dir=self.knowledge_dir)
        self.assertIn('error-retry', context)
        self.assertIn('Retry with backoff', context)
        self.assertIn('organization knowledge base', context)

    def test_build_rag_context_no_match(self):
        context = build_rag_context('quantum computing', knowledge_dir=self.knowledge_dir)
        self.assertEqual(context, '')

    def test_build_rag_context_respects_max_tokens(self):
        context = build_rag_context('retry', max_tokens=10, knowledge_dir=self.knowledge_dir)
        # With 10 tokens (~40 chars), output should be truncated or empty
        self.assertLessEqual(len(context), 200)

    def test_build_rag_context_empty_knowledge(self):
        empty_dir = os.path.join(self.tmpdir, 'empty_knowledge')
        os.makedirs(empty_dir)
        context = build_rag_context('retry', knowledge_dir=empty_dir)
        self.assertEqual(context, '')

    def test_build_rag_context_includes_category(self):
        context = build_rag_context('retry', knowledge_dir=self.knowledge_dir)
        self.assertIn('resilience', context)

    def test_build_rag_context_multiple_matches(self):
        # Add more patterns that match a common query
        patterns_file = os.path.join(self.knowledge_dir, 'patterns.jsonl')
        with open(patterns_file, 'a') as f:
            f.write(json.dumps({'name': 'retry-queue', 'description': 'Queue-based retry', 'category': 'resilience'}) + '\n')
        context = build_rag_context('retry', knowledge_dir=self.knowledge_dir)
        self.assertIn('error-retry', context)
        self.assertIn('retry-queue', context)


if __name__ == '__main__':
    unittest.main()
