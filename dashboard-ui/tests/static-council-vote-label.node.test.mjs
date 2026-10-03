// Static content guards for council vote label in the dashboard.
//
// S-213: the cost.html table header "Council vote" and the proofs.html badge
// with prefix "council" and title attribute have no test of their own.
//
// WHAT THIS CATCHES: a typo or accidental rename in either static HTML file.
// Mutation proof: rename the header or drop the title attribute, the test fails.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PROOFS_HTML = new URL('../../dashboard/static/proofs.html', import.meta.url);
const COST_HTML = new URL('../../dashboard/static/cost.html', import.meta.url);

test('cost.html contains the "Council vote" header in the table', () => {
  const content = readFileSync(COST_HTML, 'utf8');
  // Search for the exact table header element in cost.html
  assert.match(content, /<th>Council vote<\/th>/,
    'cost.html does not contain the <th>Council vote</th> header element');
});

test('proofs.html badge has council prefix and title attribute', () => {
  const content = readFileSync(PROOFS_HTML, 'utf8');

  // Search for the badge with both the "council " prefix and the title attribute on the same span element
  assert.match(content, /<span[^>]*class="badge[^"]*"[^>]*title="Recorded council vote, not a verification result"[^>]*>council /,
    'proofs.html does not contain the council badge with expected title attribute');

  // Also verify as reverse order (title before class)
  const hasBadgeWithTitle = /title="Recorded council vote, not a verification result"/.test(content) &&
                           /class="badge[^"]*"/.test(content) &&
                           />council /.test(content);

  // More robust check: look for the exact span with both attributes
  assert.ok(
    /<span[^>]*class="badge[^"]*"[^>]*title="Recorded council vote, not a verification result"[^>]*>council |<span[^>]*title="Recorded council vote, not a verification result"[^>]*class="badge[^"]*"[^>]*>council /.test(content),
    'proofs.html badge missing the "council " prefix or title attribute'
  );
});
