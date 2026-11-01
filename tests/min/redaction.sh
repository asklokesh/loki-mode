#!/usr/bin/env bash
# redactSecrets (loki-ts/src/util/redact.ts) strips a GitHub token, an Anthropic key and
# an AWS access key from a sample string, and stays linear on adversarial input: each
# input is timed at 50k and 200k characters (best of 5); linear work grows about 4x,
# quadratic backtracking about 16x, so a growth ratio of 10 or more, or any single call
# over 1s, fails. Growth, not a wall-clock bound, so a slow CI runner does not flake.
# The secrets are assembled at run time so this file holds no credential-shaped literal.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/redact.ts: add an O(n^2) loop to redactSecrets (for each index
#      i, s.slice(i).indexOf("\u0001")): the growth case fails.
#   2. loki-ts/src/util/redact.ts: delete the GitHub token rule (the `gh[pousr]_` line):
#      the GitHub case fails. (Deleting only the Anthropic rule does not fail: the
#      generic sk- rule still catches that key.)

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
cd "$ROOT" || exit 2

echo "TEST: secret redaction is complete and linear"

cat > "$T/redact-check.ts" <<TS
import { redactSecrets } from "$ROOT/loki-ts/src/util/redact.ts";

const gh = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const anthropic = "sk-ant-" + "api03-" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6Ll5Kk4Jj3Ii2Hh1Gg0Ff9Ee8Dd7Cc6Bb5Aa4Zz3Yy2Xx1";
const aws = "AKIA" + "QWERTYUIOP123456";
const out = redactSecrets("gh=" + gh + " anthropic=" + anthropic + " aws=" + aws + " ok=plain");
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
res("GitHub token redacted", !out.includes(gh));
res("Anthropic key redacted", !out.includes(anthropic));
res("AWS access key redacted", !out.includes(aws));
res("plain text kept", out.includes("ok=plain"));

const builders: ((n: number) => string)[] = [
  (n) => "a".repeat(n), (n) => "a".repeat(n) + "token", (n) => "x".repeat(n) + "token=" + "y".repeat(n),
  (n) => "a_".repeat(n / 2) + "token", (n) => "-".repeat(n), (n) => "token".repeat(n / 5),
  (n) => "token=".repeat(Math.floor(n / 6)), (n) => "SG.".repeat(Math.floor(n / 3)), (n) => "ya29.".repeat(n / 5),
  (n) => "key-".repeat(n / 4), (n) => "dapi".repeat(n / 4), (n) => "dckr_pat_".repeat(Math.floor(n / 9)),
  (n) => "SK".repeat(n / 2), (n) => "pypi-AgEI".repeat(Math.floor(n / 9)),
];
const best = (input: string): number => {
  let m = Infinity;
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); redactSecrets(input); m = Math.min(m, performance.now() - t0); }
  return m;
};
let worst = 0, slow = 0;
for (const build of builders) {
  const small = best(build(50000)), big = best(build(200000));
  worst = Math.max(worst, big / Math.max(small, 1));
  if (big >= 1000) slow++;
}
res("growth 50k to 200k stays under 10x (worst " + worst.toFixed(1) + "x)", worst < 10);
res("no single call takes 1s", slow === 0);
TS

out="$(bun run "$T/redact-check.ts" 2>&1)"
while IFS= read -r l; do
    case "$l" in
        "OK "*) ok "${l#OK }" ;;
        "NO "*) bad "${l#NO }" ;;
        *) [ -n "$l" ] && bad "unexpected output: $l" ;;
    esac
done <<< "$out"

finish
