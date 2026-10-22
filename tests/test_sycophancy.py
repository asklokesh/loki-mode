"""Tests for sycophancy detection module."""

import unittest
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'swarm'))

from sycophancy import detect_sycophancy, classify_sycophancy, generate_sycophancy_report


class TestDetectSycophancy(unittest.TestCase):
    """Tests for detect_sycophancy function."""

    def test_empty_votes_returns_zero(self):
        self.assertEqual(detect_sycophancy([]), 0.0)

    def test_single_vote_returns_zero(self):
        votes = [{'verdict': 'APPROVE', 'reasoning': 'looks good', 'issues': []}]
        self.assertEqual(detect_sycophancy(votes), 0.0)

    def test_none_votes_returns_zero(self):
        self.assertEqual(detect_sycophancy(None), 0.0)

    def test_unanimous_identical_votes_high_score(self):
        """Unanimous votes with identical reasoning should score high."""
        votes = [
            {
                'verdict': 'APPROVE',
                'reasoning': 'All requirements are met and tests pass',
                'issues': [],
            },
            {
                'verdict': 'APPROVE',
                'reasoning': 'All requirements are met and tests pass',
                'issues': [],
            },
            {
                'verdict': 'APPROVE',
                'reasoning': 'All requirements are met and tests pass',
                'issues': [],
            },
        ]
        score = detect_sycophancy(votes)
        self.assertGreater(score, 0.5)

    def test_justification_key_scores_like_legacy_reasoning(self):
        """The renamed field is read; a legacy reasoning vote scores the same."""
        text = 'All requirements are met and tests pass'
        new = [{'verdict': 'APPROVE', 'justification': text, 'issues': []} for _ in range(3)]
        old = [{'verdict': 'APPROVE', 'reasoning': text, 'issues': []} for _ in range(3)]
        self.assertGreater(detect_sycophancy(new), 0.5)
        self.assertEqual(detect_sycophancy(new), detect_sycophancy(old))
        mixed = new[:1] + old[1:]
        self.assertEqual(detect_sycophancy(mixed), detect_sycophancy(old))

    def test_diverse_votes_low_score(self):
        """Diverse votes with different reasoning should score low."""
        votes = [
            {
                'verdict': 'APPROVE',
                'reasoning': 'The implementation covers all PRD requirements thoroughly',
                'issues': [{'severity': 'LOW', 'description': 'minor style issue'}],
            },
            {
                'verdict': 'REJECT',
                'reasoning': 'Test coverage is insufficient for critical paths',
                'issues': [
                    {'severity': 'HIGH', 'description': 'missing integration tests'},
                    {'severity': 'MEDIUM', 'description': 'no error handling tests'},
                ],
            },
            {
                'verdict': 'APPROVE',
                'reasoning': 'Code quality is excellent with good separation of concerns',
                'issues': [],
            },
        ]
        score = detect_sycophancy(votes)
        self.assertLess(score, 0.5)

    def test_all_approve_no_issues_suspicious(self):
        """All approvals with zero issues should be somewhat suspicious."""
        votes = [
            {'verdict': 'APPROVE', 'reasoning': 'good', 'issues': []},
            {'verdict': 'APPROVE', 'reasoning': 'fine', 'issues': []},
            {'verdict': 'APPROVE', 'reasoning': 'ok', 'issues': []},
        ]
        score = detect_sycophancy(votes)
        # Should be elevated due to unanimity and zero issues
        self.assertGreater(score, 0.3)

    def test_score_bounded_zero_to_one(self):
        """Score should always be between 0.0 and 1.0."""
        votes = [
            {'verdict': 'APPROVE', 'reasoning': 'x', 'issues': []},
            {'verdict': 'APPROVE', 'reasoning': 'x', 'issues': []},
        ]
        score = detect_sycophancy(votes)
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 1.0)

    def test_missing_fields_handled_gracefully(self):
        """Votes with missing fields should not crash."""
        votes = [
            {'verdict': 'APPROVE'},
            {'verdict': 'REJECT'},
            {},
        ]
        score = detect_sycophancy(votes)
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 1.0)

    def test_issue_severity_uniformity(self):
        """Identical issue severities should increase the score."""
        votes = [
            {
                'verdict': 'APPROVE',
                'reasoning': 'acceptable',
                'issues': [{'severity': 'LOW', 'description': 'minor'}],
            },
            {
                'verdict': 'APPROVE',
                'reasoning': 'fine',
                'issues': [{'severity': 'LOW', 'description': 'trivial'}],
            },
        ]
        score_uniform = detect_sycophancy(votes)

        votes_diverse = [
            {
                'verdict': 'APPROVE',
                'reasoning': 'acceptable',
                'issues': [{'severity': 'CRITICAL', 'description': 'security hole'}],
            },
            {
                'verdict': 'REJECT',
                'reasoning': 'problems found',
                'issues': [
                    {'severity': 'LOW', 'description': 'trivial'},
                    {'severity': 'HIGH', 'description': 'missing tests'},
                ],
            },
        ]
        score_diverse = detect_sycophancy(votes_diverse)

        self.assertGreater(score_uniform, score_diverse)

    def test_string_issues_handled(self):
        """Issues that are plain strings (not dicts) should be handled."""
        votes = [
            {'verdict': 'APPROVE', 'reasoning': 'ok', 'issues': ['LOW', 'LOW']},
            {'verdict': 'APPROVE', 'reasoning': 'ok', 'issues': ['LOW']},
        ]
        score = detect_sycophancy(votes)
        self.assertGreaterEqual(score, 0.0)


class TestClassifySycophancy(unittest.TestCase):
    """Tests for classify_sycophancy function."""

    def test_independent(self):
        self.assertEqual(classify_sycophancy(0.0), 'independent')
        self.assertEqual(classify_sycophancy(0.29), 'independent')

    def test_mild(self):
        self.assertEqual(classify_sycophancy(0.3), 'mild')
        self.assertEqual(classify_sycophancy(0.49), 'mild')

    def test_moderate(self):
        self.assertEqual(classify_sycophancy(0.5), 'moderate')
        self.assertEqual(classify_sycophancy(0.69), 'moderate')

    def test_severe(self):
        self.assertEqual(classify_sycophancy(0.7), 'severe')
        self.assertEqual(classify_sycophancy(1.0), 'severe')


class TestGenerateSycophancyReport(unittest.TestCase):
    """Tests for generate_sycophancy_report function."""

    def test_report_contains_score(self):
        votes = [
            {'verdict': 'APPROVE', 'issues': []},
            {'verdict': 'APPROVE', 'issues': []},
        ]
        report = generate_sycophancy_report(votes, 0.45)
        self.assertIn('0.45', report)
        self.assertIn('mild', report)

    def test_report_contains_verdict_info(self):
        votes = [
            {'verdict': 'APPROVE', 'issues': []},
            {'verdict': 'REJECT', 'issues': [{'severity': 'HIGH', 'description': 'x'}]},
        ]
        report = generate_sycophancy_report(votes, 0.2)
        self.assertIn('APPROVE', report)
        self.assertIn('REJECT', report)
        self.assertIn('Reviewers: 2', report)

    def test_high_score_includes_warning(self):
        votes = [
            {'verdict': 'APPROVE', 'issues': []},
            {'verdict': 'APPROVE', 'issues': []},
        ]
        report = generate_sycophancy_report(votes, 0.75)
        self.assertIn('WARNING', report)
        self.assertIn('devil\'s advocate', report)

    def test_low_score_no_warning(self):
        votes = [
            {'verdict': 'APPROVE', 'issues': []},
            {'verdict': 'REJECT', 'issues': []},
        ]
        report = generate_sycophancy_report(votes, 0.15)
        self.assertNotIn('WARNING', report)

    def test_report_contains_issue_counts(self):
        votes = [
            {'verdict': 'APPROVE', 'issues': ['a', 'b']},
            {'verdict': 'APPROVE', 'issues': []},
        ]
        report = generate_sycophancy_report(votes, 0.4)
        self.assertIn('Issue counts: 2, 0', report)


if __name__ == '__main__':
    unittest.main()
