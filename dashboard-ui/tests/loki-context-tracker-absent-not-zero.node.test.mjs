// Absent is not zero, in the component that renders tokens beside cost.
//
// WHAT THIS CAUGHT. loki-context-tracker rendered "tokens=0  cost=unknown" in
// the SAME timeline row: _formatTokens(null) returned '0' and the four token
// fields were summed with `|| 0`, so four nulls produced a measured-looking
// total for a run nobody counted. An operator reads "0 tokens" as a
// measurement, which is the violation record_is_measured() exists to prevent.
//
// BOTH DIRECTIONS ARE ASSERTED. A helper that renders "unknown" for a
// genuinely measured 0 is exactly as wrong as one that renders 0 for absent
// data, and a test that only checks the null case would pass either way.
//
// The methods are extracted from the real component source rather than
// reimplemented, so this cannot drift away from what actually ships.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../components/loki-context-tracker.js', import.meta.url),'utf8');
const pick = (name) => {
  const i = src.indexOf(`  ${name}(`);
  if (i < 0) throw new Error('method not found: ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k+1); }
  }
};
const body = [pick('_formatTokens'), pick('_formatUSD'), pick('_sumTokens')].join(',\n');
const obj = eval(`({${body}})`);

let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok?'OK  ':'BAD '} ${label.padEnd(46)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

check('unmeasured tokens -> unknown', obj._formatTokens(null), 'unknown');
check('MEASURED zero tokens -> 0', obj._formatTokens(0), '0');
check('real tokens still format', obj._formatTokens(1500), '1.5K');
check('unmeasured cost -> unknown', obj._formatUSD(null), 'unknown');
check('MEASURED zero cost -> $0.00', obj._formatUSD(0), '$0.00');
check('all four token fields null -> null', obj._sumTokens({}), null);
check('one measured field -> sum', obj._sumTokens({input_tokens: 10}), 10);
check('measured zero -> 0 not null', obj._sumTokens({input_tokens: 0}), 0);
check('mixed null+measured sums measured', obj._sumTokens({input_tokens: 5, output_tokens: null}), 5);
console.log(fail ? `FAILURES: ${fail}` : 'all assertions passed');
process.exit(fail ? 1 : 0);
