"""Sycophancy detection for council review system.

Detects when reviewers are rubber-stamping rather than independently evaluating.
Scores range from 0.0 (fully independent) to 1.0 (likely sycophantic).
"""

import json
import re
from collections import Counter


def detect_sycophancy(votes):
    """Score how likely the votes are sycophantic.

    Args:
        votes: List of vote dicts, each with 'verdict', 'reasoning', 'issues', 'timestamp'

    Returns:
        float: Sycophancy score (0.0 = independent, 1.0 = rubber-stamped)
    """
    if not votes or len(votes) < 2:
        return 0.0

    signals = []

    # Signal 1: Verdict unanimity (all same verdict)
    verdicts = [v.get('verdict', '').upper() for v in votes]
    verdict_counts = Counter(verdicts)
    most_common_count = verdict_counts.most_common(1)[0][1]
    unanimity_score = most_common_count / len(verdicts)
    signals.append(unanimity_score * 0.3)  # Weight: 30%

    # Signal 2: Reasoning text similarity (Jaccard on word sets)
    reasonings = [set(re.findall(r'\w+', (v.get('justification') or v.get('reasoning') or '').lower())) for v in votes]
    if all(len(r) > 0 for r in reasonings):
        similarity_scores = []
        for i in range(len(reasonings)):
            for j in range(i + 1, len(reasonings)):
                intersection = len(reasonings[i] & reasonings[j])
                union = len(reasonings[i] | reasonings[j])
                if union > 0:
                    similarity_scores.append(intersection / union)
        avg_similarity = sum(similarity_scores) / len(similarity_scores) if similarity_scores else 0
        signals.append(avg_similarity * 0.3)  # Weight: 30%
    else:
        signals.append(0.0)

    # Signal 3: Issue severity uniformity
    all_severities = []
    for v in votes:
        issues = v.get('issues', [])
        for issue in issues:
            if isinstance(issue, dict):
                all_severities.append(issue.get('severity', '').upper())
            elif isinstance(issue, str):
                all_severities.append(issue)
    if all_severities:
        severity_counts = Counter(all_severities)
        most_common_sev = severity_counts.most_common(1)[0][1]
        uniformity = most_common_sev / len(all_severities) if all_severities else 0
        signals.append(uniformity * 0.2)  # Weight: 20%
    else:
        signals.append(0.0)

    # Signal 4: Issue count similarity
    issue_counts = [len(v.get('issues', [])) for v in votes]
    if max(issue_counts) > 0:
        count_range = max(issue_counts) - min(issue_counts)
        count_avg = sum(issue_counts) / len(issue_counts)
        count_uniformity = 1.0 - (count_range / max(count_avg, 1))
        signals.append(max(0, count_uniformity) * 0.2)  # Weight: 20%
    else:
        # All zero issues = suspicious
        signals.append(0.15)

    total_score = sum(signals)
    return min(1.0, max(0.0, total_score))


def classify_sycophancy(score):
    """Classify the sycophancy score into a category.

    Returns:
        str: 'independent', 'mild', 'moderate', or 'severe'
    """
    if score < 0.3:
        return 'independent'
    elif score < 0.5:
        return 'mild'
    elif score < 0.7:
        return 'moderate'
    else:
        return 'severe'


def generate_sycophancy_report(votes, score):
    """Generate a human-readable sycophancy analysis report.

    Returns:
        str: Multi-line report
    """
    classification = classify_sycophancy(score)
    lines = [
        'Sycophancy Analysis Report',
        '=' * 30,
        'Score: {:.2f} ({})'.format(score, classification),
        'Reviewers: {}'.format(len(votes)),
    ]

    verdicts = [v.get('verdict', 'unknown') for v in votes]
    lines.append('Verdicts: {}'.format(', '.join(verdicts)))

    issue_counts = [len(v.get('issues', [])) for v in votes]
    lines.append('Issue counts: {}'.format(', '.join(str(c) for c in issue_counts)))

    if classification in ('moderate', 'severe'):
        lines.append('')
        lines.append('WARNING: High sycophancy score detected.')
        lines.append('Recommendation: Add a devil\'s advocate reviewer or require re-review with stricter independence.')

    return '\n'.join(lines)
