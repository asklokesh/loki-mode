#!/usr/bin/env bash
# Test: USAGE.md panel renders markdown instead of preformatted text.
# Checks the built dashboard/static/index.html for the render function
# and a representative markdown-to-HTML conversion call.

set -euo pipefail

STATIC_HTML="/Users/lokesh/git/loki-mode/dashboard/static/index.html"
SCRIPT_JS="/Users/lokesh/git/loki-mode/dashboard-ui/scripts/build-standalone.js"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local pattern="$2"
  local file="$3"
  if grep -qE "$pattern" "$file"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (pattern: $pattern)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== test-usage-markdown-render.sh ==="

# 1. The build script defines renderUsageMarkdown
check "build-standalone.js defines renderUsageMarkdown" \
  "function renderUsageMarkdown" "$SCRIPT_JS"

# 2. Built HTML contains renderUsageMarkdown
check "built index.html contains renderUsageMarkdown" \
  "renderUsageMarkdown" "$STATIC_HTML"

# 3. usage-md CSS class present in built HTML
check "built index.html has usage-md CSS class" \
  "usage-md" "$STATIC_HTML"

# 4. Container div uses class usage-md (not a pre element)
check "built index.html uses div.usage-md (not pre#usage-doc-content)" \
  'id="usage-doc-content" class="usage-md"' "$STATIC_HTML"

# 5. No bare pre#usage-doc-content (old pattern is gone)
if grep -qE 'pre id="usage-doc-content"' "$STATIC_HTML"; then
  echo "FAIL: old pre#usage-doc-content element still present"
  FAIL=$((FAIL + 1))
else
  echo "PASS: old pre#usage-doc-content removed"
  PASS=$((PASS + 1))
fi

# 6. innerHTML assignment used (markdown rendered into DOM)
check "built index.html uses innerHTML for rendered markdown" \
  "innerHTML.*renderUsageMarkdown" "$STATIC_HTML"

# 7. Heading render path present (h1..h6 output)
check "build-standalone.js renders headings via h-tags" \
  "'<h' \+ level" "$SCRIPT_JS"

# 8. Fenced code block detection present
check "build-standalone.js detects fenced code blocks" \
  "BT3" "$SCRIPT_JS"

# 9. CSS for usage-md code blocks is in build script
check "build-standalone.js has CSS for usage-md pre code" \
  "usage-md.*pre" "$SCRIPT_JS"

# 10. v7.7.11 XSS guard: javascript: / data: URLs in markdown links
#     must NOT survive as href; build script must enforce scheme allowlist.
check "build-standalone.js link-href has scheme allowlist (xss guard)" \
  "XSS guard" "$SCRIPT_JS"

# 11. v7.7.11 XSS guard: defensive grep -- href construction in link path must
#     gate on the safe scheme check (no unconditional 'href="' + url +).
check "build-standalone.js link href is gated on safe-scheme check" \
  "if \(safe\) return '<a href" "$SCRIPT_JS"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
