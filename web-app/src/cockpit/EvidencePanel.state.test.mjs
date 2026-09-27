// S-207 / BACKLOG 114: a failed api.getChecklist was swallowed by .catch(), so
// the checklist stayed null and the Evidence panel said "No gate results
// recorded": a claim about a file the cockpit never managed to read.
//
// EvidencePanel.tsx is JSX and imports ../api/client (browser-only at module
// load), so plain `node --test` cannot import it. ponytail: lift the pure
// gateResultsEmptyText helper out of the source, strip types with node:module
// and evaluate it; pin the fetch and prop wiring with source checks.
// Run: node --test web-app/src/cockpit/EvidencePanel.state.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const panel = read('./EvidencePanel.tsx');
const hook = read('./useCockpitState.ts');
const cockpit = read('./ExecutionCockpit.tsx');

function loadHelper() {
  const start = panel.indexOf('export function gateResultsEmptyText');
  assert.ok(start >= 0, 'gateResultsEmptyText not found in EvidencePanel.tsx');
  const end = panel.indexOf('\n}\n', start);
  assert.ok(end > start, 'gateResultsEmptyText end not found');
  return new Function(
    `${stripTypeScriptTypes(panel.slice(start + 'export '.length, end + 2))}\nreturn gateResultsEmptyText;`,
  )();
}

test('a failed checklist request reads Could not load gate results, not No gate results recorded', () => {
  const text = loadHelper()('HTTP 500');
  assert.match(text, /Could not load gate results/);
  assert.doesNotMatch(text, /No gate results recorded/);
});

test('items [] with no error keeps No gate results recorded', () => {
  const text = loadHelper()(null);
  assert.match(text, /No gate results recorded/);
  assert.doesNotMatch(text, /Could not load/);
});

test('the empty branch renders the helper, not a literal sentence', () => {
  const helper = panel.slice(panel.indexOf('export function gateResultsEmptyText'));
  const rest = panel.replace(helper.slice(0, helper.indexOf('\n}\n') + 3), '');
  assert.ok(!/No gate results recorded/.test(rest), 'EvidencePanel renders a literal "No gate results recorded" outside the helper');
  assert.ok(/gateResultsEmptyText\(checklistError\)/.test(rest), 'empty branch does not call gateResultsEmptyText(checklistError)');
});

test('getChecklist goes through settle and its error reaches EvidencePanel', () => {
  assert.ok(!/api\.getChecklist\(\)\.then/.test(hook), 'getChecklist still swallows its failure with .then/.catch');
  assert.ok(/settle\(api\.getChecklist\(\)/.test(hook), 'getChecklist does not go through settle');
  assert.ok(/setChecklistError\(/.test(hook), 'the checklist error is never stored');
  assert.ok(/checklistError: scopeChecklistToLive\(checklistError, isLive\)/.test(hook), 'checklistError is not returned from the hook');
  assert.ok(/<EvidencePanel[^>]*checklistError=\{s\.checklistError\}/.test(cockpit), 'ExecutionCockpit does not pass checklistError to EvidencePanel');
});
