'use strict';

const fs = require('fs');
const path = require('path');

/**
 * loki/quality-report tool
 *
 * Returns quality gate results, blind review scores, and council votes.
 */

const TOOL_NAME = 'loki/quality-report';

const schema = {
  name: TOOL_NAME,
  description: 'Get quality gate results including blind review scores, council votes, and gate pass/fail status.',
  inputSchema: {
    type: 'object',
    properties: {
      gate: {
        type: 'string',
        description: 'Specific gate to query (optional, returns all gates if not specified)'
      },
      verbose: {
        type: 'boolean',
        description: 'Include detailed review comments (default: false)',
        default: false
      }
    },
    required: []
  }
};

function execute(params) {
  const lokiDir = path.resolve(process.cwd(), '.loki');
  const stateDir = path.join(lokiDir, 'state');
  const specificGate = params.gate || null;
  const verbose = params.verbose || false;

  const report = {
    success: true,
    timestamp: new Date().toISOString(),
    gates: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0
    },
    blindReview: null,
    councilVotes: null
  };

  // Read quality gates
  const gatesPath = path.join(stateDir, 'quality-gates.json');
  if (fs.existsSync(gatesPath)) {
    try {
      const gatesData = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
      let gates = gatesData.results || gatesData.gates || [];

      if (specificGate) {
        gates = gates.filter((g) =>
          (g.name || '').toLowerCase() === specificGate.toLowerCase() ||
          (g.id || '').toLowerCase() === specificGate.toLowerCase()
        );
      }

      report.gates = gates.map((g) => {
        const entry = {
          name: g.name || g.id || 'unknown',
          status: g.passed ? 'passed' : (g.status || 'unknown'),
          severity: g.severity || 'medium',
          message: g.message || ''
        };
        if (verbose && g.details) {
          entry.details = g.details;
        }
        return entry;
      });

      report.summary.total = report.gates.length;
      for (const g of report.gates) {
        if (g.status === 'passed') report.summary.passed++;
        else if (g.status === 'skipped') report.summary.skipped++;
        else report.summary.failed++;
      }
    } catch (err) {
      // Ignore
    }
  }

  // Read blind review results
  const reviewPath = path.join(stateDir, 'blind-review.json');
  if (fs.existsSync(reviewPath)) {
    try {
      const reviewData = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
      report.blindReview = {
        reviewers: reviewData.reviewers || [],
        averageScore: reviewData.averageScore || null,
        consensus: reviewData.consensus || null,
        unanimous: reviewData.unanimous || false
      };
      if (verbose && reviewData.comments) {
        report.blindReview.comments = reviewData.comments;
      }
    } catch (err) {
      // Ignore
    }
  }

  // Read council votes
  const councilPath = path.join(stateDir, 'council-votes.json');
  if (fs.existsSync(councilPath)) {
    try {
      const councilData = JSON.parse(fs.readFileSync(councilPath, 'utf8'));
      report.councilVotes = {
        votes: councilData.votes || [],
        decision: councilData.decision || null,
        devilsAdvocateTriggered: councilData.devilsAdvocateTriggered || false
      };
    } catch (err) {
      // Ignore
    }
  }

  // Overall verdict
  if (report.summary.total > 0) {
    report.verdict = report.summary.failed === 0 ? 'PASS' : 'FAIL';
    report.blocking = report.gates
      .filter((g) => g.status !== 'passed' && g.status !== 'skipped' &&
                     (g.severity === 'critical' || g.severity === 'high'))
      .map((g) => g.name);
  } else {
    report.verdict = 'NO_DATA';
    report.blocking = [];
  }

  return report;
}

// Result keys carrying stored text; the server moves them under untrusted_content.
const UNTRUSTED_FIELDS = ['gates', 'blindReview', 'councilVotes', 'blocking'];

module.exports = { TOOL_NAME, schema, execute, UNTRUSTED_FIELDS };
