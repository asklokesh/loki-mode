#!/usr/bin/env bash
#===============================================================================
# Playwright Smoke Test Module (v5.46.0)
#
# Runs lightweight smoke tests against a running user application to verify
# it loads correctly. Advisory only - failures do NOT block iterations or
# council approval.
#
# Functions:
#   playwright_verify_init()        - Check/install Playwright
#   playwright_verify_app(url)      - Run smoke test against URL
#   playwright_verify_should_run()  - Check if verification should run
#   playwright_verify_summary()     - One-line summary for prompt injection
#   playwright_verify_as_evidence() - Formatted output for council evidence
#
# Environment Variables:
#   LOKI_PLAYWRIGHT_ENABLED    - Enable/disable (default: true)
#   LOKI_PLAYWRIGHT_INTERVAL   - Run every N iterations (default: 5)
#   LOKI_PLAYWRIGHT_TIMEOUT    - Page load timeout in ms (default: 15000)
#
# Data:
#   .loki/verification/playwright-results.json  - Last results
#   .loki/verification/screenshots/             - Captured screenshots
#
#===============================================================================

# Configuration
PLAYWRIGHT_ENABLED=${LOKI_PLAYWRIGHT_ENABLED:-true}
PLAYWRIGHT_INTERVAL=${LOKI_PLAYWRIGHT_INTERVAL:-5}
# Guard against zero/negative interval (division by zero in modulo)
if [ "$PLAYWRIGHT_INTERVAL" -le 0 ] 2>/dev/null; then
    PLAYWRIGHT_INTERVAL=5
fi
PLAYWRIGHT_TIMEOUT=${LOKI_PLAYWRIGHT_TIMEOUT:-15000}
# Derive seconds for the outer timeout wrapper (add buffer for browser startup)
PLAYWRIGHT_TIMEOUT_SEC=$(( (PLAYWRIGHT_TIMEOUT / 1000) + 15 ))

# Internal state
PLAYWRIGHT_VERIFY_DIR=""
PLAYWRIGHT_RESULTS_FILE=""
PLAYWRIGHT_LAST_VERIFY_ITERATION=0
PLAYWRIGHT_AVAILABLE=false
PLAYWRIGHT_MAX_SCREENSHOTS=10

#===============================================================================
# Initialization
#===============================================================================

playwright_verify_init() {
    # Check if npx playwright is available; attempt chromium install if needed.
    # Returns 0 if playwright available, 1 if not.

    if [ "$PLAYWRIGHT_ENABLED" != "true" ]; then
        return 1
    fi

    PLAYWRIGHT_VERIFY_DIR=".loki/verification"
    PLAYWRIGHT_RESULTS_FILE="${PLAYWRIGHT_VERIFY_DIR}/playwright-results.json"
    mkdir -p "${PLAYWRIGHT_VERIFY_DIR}/screenshots"

    # Check if playwright is accessible via npx
    if ! npx playwright --version &>/dev/null; then
        log_warn "Playwright not found via npx - smoke tests disabled"
        PLAYWRIGHT_AVAILABLE=false
        return 1
    fi

    # Check if chromium browser is installed; attempt install if not
    if ! npx playwright install --dry-run chromium &>/dev/null; then
        log_info "Installing Playwright chromium browser..."
        if ! timeout 60 npx playwright install chromium &>/dev/null; then
            log_warn "Failed to install Playwright chromium - smoke tests disabled"
            PLAYWRIGHT_AVAILABLE=false
            return 1
        fi
    fi

    PLAYWRIGHT_AVAILABLE=true
    log_info "Playwright smoke tests initialized (every ${PLAYWRIGHT_INTERVAL} iterations, ${PLAYWRIGHT_TIMEOUT}ms timeout)"
    return 0
}

#===============================================================================
# Interval Control
#===============================================================================

playwright_verify_should_run() {
    # Returns 0 (true) if verification should run this iteration
    if [ "$PLAYWRIGHT_ENABLED" != "true" ]; then
        return 1
    fi

    if [ "$PLAYWRIGHT_AVAILABLE" != "true" ]; then
        return 1
    fi

    local current_iteration="${ITERATION_COUNT:-0}"
    if [ "$current_iteration" -eq 0 ]; then
        return 1
    fi

    if [ $((current_iteration % PLAYWRIGHT_INTERVAL)) -ne 0 ]; then
        return 1
    fi

    # Don't verify same iteration twice
    if [ "$current_iteration" -eq "$PLAYWRIGHT_LAST_VERIFY_ITERATION" ]; then
        return 1
    fi

    return 0
}

#===============================================================================
# Smoke Test
#===============================================================================

playwright_verify_app() {
    local url="$1"

    if [ -z "$url" ]; then
        log_warn "playwright_verify_app: no URL provided"
        return 0
    fi

    local verify_dir="${PLAYWRIGHT_VERIFY_DIR:-.loki/verification}"
    local screenshots_dir="${verify_dir}/screenshots"
    mkdir -p "$screenshots_dir"

    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H%M%SZ)
    local screenshot_path="${screenshots_dir}/verify-${timestamp}.png"
    local results_file="${verify_dir}/playwright-results.json"
    local script_file="${verify_dir}/.smoke-test.js"

    log_step "Running Playwright smoke test against ${url}..."

    # Generate inline smoke test script
    cat > "$script_file" << 'SMOKE_SCRIPT'
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  const screenshotPath = process.argv[3];
  const resultsPath = process.argv[4];
  const pageTimeout = parseInt(process.argv[5] || '15000', 10);
  const startTime = Date.now();

  const results = {
    verified_at: new Date().toISOString(),
    url: url,
    passed: false,
    checks: {
      page_loads: false,
      no_5xx: false,
      no_console_errors: true,
      has_title: false,
      has_content: false
    },
    screenshot: screenshotPath,
    errors: [],
    duration_ms: 0
  };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Collect console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Navigate to URL
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: pageTimeout
    });
    results.checks.page_loads = true;

    // Check HTTP status (no 5xx)
    const status = response ? response.status() : 0;
    results.checks.no_5xx = status < 500;
    if (status >= 500) results.errors.push('HTTP ' + status);

    // Check console errors
    if (consoleErrors.length > 0) {
      results.checks.no_console_errors = false;
      results.errors.push(...consoleErrors.slice(0, 5));
    }

    // Check page title
    const title = await page.title();
    results.checks.has_title = title.length > 0;

    // Check visible content
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() || '');
    results.checks.has_content = bodyText.length > 0;

    // Capture screenshot
    await page.screenshot({ path: screenshotPath, fullPage: false });

    // Determine overall pass
    results.passed = Object.values(results.checks).every(v => v === true);

  } catch (err) {
    results.errors.push(err.message);
  } finally {
    if (browser) await browser.close();
    results.duration_ms = Date.now() - startTime;

    // Atomic write: temp file then rename
    const fs = require('fs');
    const tmp = resultsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(results, null, 2));
    fs.renameSync(tmp, resultsPath);
  }

  process.exit(results.passed ? 0 : 1);
})();
SMOKE_SCRIPT

    # Run with outer timeout (never block iteration)
    timeout "${PLAYWRIGHT_TIMEOUT_SEC}" node "$script_file" \
        "$url" "$screenshot_path" "$results_file" "$PLAYWRIGHT_TIMEOUT" 2>/dev/null
    local exit_code=$?

    # Clean up generated script
    rm -f "$script_file"

    # Update tracking state
    PLAYWRIGHT_LAST_VERIFY_ITERATION="${ITERATION_COUNT:-0}"

    # Rotate screenshots: keep only the most recent N
    _playwright_rotate_screenshots "$screenshots_dir"

    # Log result
    if [ -f "$results_file" ]; then
        local summary
        summary=$(playwright_verify_summary 2>/dev/null || true)
        if [ -n "$summary" ]; then
            log_info "Playwright: $summary"
        fi
    elif [ "$exit_code" -eq 124 ]; then
        log_warn "Playwright smoke test timed out after ${PLAYWRIGHT_TIMEOUT_SEC}s"
    else
        log_warn "Playwright smoke test failed (exit $exit_code)"
    fi

    # Never fail the iteration
    return 0
}

#===============================================================================
# Functional Proof (Proof-of-Function dynamic half) -- PERSISTENCE + AUTH
#===============================================================================
#
# Drives the RUNNING app and writes .loki/verification/functional-proof.json
# with an explicit tri-state per property that council_evidence_gate reads:
#   {"persistence": {"attempted": bool, "proven": bool, "reason": str},
#    "auth":        {"attempted": bool, "proven": bool, "reason": str},
#    "url": str, "verified_at": str}
#
# PERSISTENCE: discovers a create path (a <form> with a submit, or an Add/Create/
#   Save button), fills it with a UNIQUE sentinel token (loki-persist-<uuid>),
#   submits, waits for network idle, RELOADS, and asserts the sentinel is present
#   after reload (a real DB/API read-back). proven=false if it does not survive
#   -> the gate BLOCKS. no create path -> attempted:false reason=no_create_path.
#
# AUTH: if an auth signal is detected (a login/signin route/link, or
#   LOKI_PROOF_PROTECTED_PATH configured), issues a logged-out request to a
#   protected route and asserts REJECTION (401/403 or redirect to login).
#   A login screen that merely renders -> proven:false -> BLOCK. No auth signal
#   -> attempted:false reason=no_auth.
#
# Never blocks the iteration itself (|| true at the call site). The council gate
# is what turns proven:false into a BLOCK. Interval + serveable gated upstream.
# Opt out per-axis with LOKI_PROOF_PERSIST=0 / LOKI_PROOF_AUTH=0 at the gate.
#
# Env knobs:
#   LOKI_PROOF_CREATE_SELECTOR  - CSS selector to point the driver at a form
#   LOKI_PROOF_PROTECTED_PATH   - path to test for a logged-out rejection
#   LOKI_PROOF_RELOAD_WAIT_MS   - wait before asserting sentinel absence (flake)
#===============================================================================

playwright_prove_functional() {
    local url="$1"

    if [ -z "$url" ]; then
        log_warn "playwright_prove_functional: no URL provided"
        return 0
    fi

    local verify_dir="${PLAYWRIGHT_VERIFY_DIR:-.loki/verification}"
    local screenshots_dir="${verify_dir}/screenshots"
    mkdir -p "$screenshots_dir"

    local results_file="${verify_dir}/functional-proof.json"
    local script_file="${verify_dir}/.functional-proof.js"

    # BUG 1a: invalidate any PRIOR proof BEFORE driving. A timeout (exit 124) or a
    # driver hang must not leave a stale proven:true from an earlier iteration that
    # the gate would read as current. The node script re-writes a fresh, stamped
    # proof in its finally; if it never gets there, the file stays absent (which
    # the gate treats as inconclusive pass-through, never a stale green).
    rm -f "$results_file" "$results_file.tmp" 2>/dev/null || true

    log_step "Running Playwright functional proof (persistence + auth) against ${url}..."

    # Freshness stamp: the current iteration and the current HEAD SHA. The council
    # gate reads this and treats a proof whose iteration does not match the current
    # ITERATION_COUNT as NOT PRESENT (inconclusive), so a stale file never passes.
    local _proof_iter="${ITERATION_COUNT:-0}"
    local _proof_head
    _proof_head="$(git rev-parse HEAD 2>/dev/null || echo '')"

    cat > "$script_file" << 'PROOF_SCRIPT'
(async () => {
  const url = process.argv[2];
  const resultsPath = process.argv[3];
  const pageTimeout = parseInt(process.argv[4] || '15000', 10);
  const reloadWaitMs = parseInt(process.env.LOKI_PROOF_RELOAD_WAIT_MS || '1500', 10);
  const createSelector = process.env.LOKI_PROOF_CREATE_SELECTOR || '';
  const protectedPath = process.env.LOKI_PROOF_PROTECTED_PATH || '';
  // Authorization / tenant-isolation knobs (all optional; absence => auto-detect
  // or inconclusive pass-through). Configured selectors are the highest-confidence
  // path; auto-detect (signup form) is the best-effort fallback.
  const azSignupSel = process.env.LOKI_PROOF_AUTHZ_SIGNUP_SELECTOR || '';
  const azLoginSel = process.env.LOKI_PROOF_AUTHZ_LOGIN_SELECTOR || '';
  const azUserField = process.env.LOKI_PROOF_AUTHZ_USER_FIELD || '';
  const azPassField = process.env.LOKI_PROOF_AUTHZ_PASS_FIELD || '';
  const azSubmitSel = process.env.LOKI_PROOF_AUTHZ_SUBMIT || '';
  const azOwnedListSel = process.env.LOKI_PROOF_AUTHZ_OWNED_LIST_SELECTOR || '';
  const azDetailTemplate = process.env.LOKI_PROOF_AUTHZ_DETAIL_URL_TEMPLATE || '';
  const azApiTemplate = process.env.LOKI_PROOF_AUTHZ_API_TEMPLATE || '';

  const results = {
    verified_at: new Date().toISOString(),
    url: url,
    // BUG 1b: freshness stamp the gate validates against the current iteration.
    stamp: {
      iteration: parseInt(process.env.LOKI_PROOF_ITER || '0', 10),
      head: process.env.LOKI_PROOF_HEAD || '',
    },
    persistence: { attempted: false, proven: false, reason: 'not_run' },
    auth: { attempted: false, proven: false, reason: 'not_run' },
    authorization: { attempted: false, proven: false, reason: 'not_run' },
  };

  const write = () => {
    const fs = require('fs');
    const tmp = resultsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(results, null, 2));
    fs.renameSync(tmp, resultsPath);
  };

  let browser;
  try {
    // BUG 3: require playwright INSIDE the try. If the driver is absent, node
    // would otherwise throw at module-top require time and write NO proof at all
    // -- which, combined with the missing-file handling, previously false-blocked.
    // A fresh fallback proof {attempted:false, reason:driver_unavailable} keeps
    // the axis inconclusive pass-through instead.
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeout });

    // ---- PERSISTENCE ----
    try {
      const sentinel = 'loki-persist-' + Math.random().toString(36).slice(2, 10);
      // Find a create path: a configured selector, else a form with a text input
      // and a submit, else an Add/Create/Save button revealing a form.
      let formHandle = null;
      if (createSelector) {
        formHandle = await page.$(createSelector);
      }
      if (!formHandle) {
        // Try to reveal a form behind an Add/Create/New/Save trigger.
        const trigger = await page.$(
          'button:has-text("Add"), button:has-text("Create"), button:has-text("New"), a:has-text("Add"), a:has-text("Create")'
        ).catch(() => null);
        if (trigger) { await trigger.click().catch(() => {}); await page.waitForTimeout(300); }
        formHandle = await page.$('form');
      }

      // Locate a fillable text input inside/near the form.
      let input = null;
      if (formHandle) {
        input = await formHandle.$('input[type="text"], input:not([type]), input[type="search"], input[type="email"], textarea').catch(() => null);
      }
      if (!input) {
        input = await page.$('input[type="text"], input:not([type]), textarea').catch(() => null);
      }

      if (!input) {
        results.persistence = { attempted: false, proven: false, reason: 'no_create_path' };
      } else {
        results.persistence.attempted = true;
        await input.fill(sentinel);
        // Submit: prefer a submit button, else press Enter.
        let submitted = false;
        const submitBtn = formHandle
          ? await formHandle.$('button[type="submit"], input[type="submit"], button:has-text("Add"), button:has-text("Create"), button:has-text("Save"), button:has-text("Submit")').catch(() => null)
          : null;
        try {
          if (submitBtn) { await submitBtn.click(); submitted = true; }
          else { await input.press('Enter'); submitted = true; }
        } catch (e) { submitted = false; }

        if (!submitted) {
          results.persistence = { attempted: true, proven: false, reason: 'submit_failed' };
        } else {
          // Wait for the write to settle, then read back in a FRESH context with
          // NO client storage. BUG 3: a plain page.reload() keeps localStorage /
          // sessionStorage / IndexedDB, so a no-backend SPA that only persists to
          // localStorage would falsely prove persistence. A brand-new context
          // (fresh cookies + empty storage) only sees the sentinel if it survived
          // in a real DB/API the server read back -- true beyond-client persistence.
          await page.waitForLoadState('networkidle', { timeout: pageTimeout }).catch(() => {});
          await page.waitForTimeout(reloadWaitMs);
          const readCtx = await browser.newContext();
          const readPage = await readCtx.newPage();
          await readPage.goto(url, { waitUntil: 'networkidle', timeout: pageTimeout }).catch(() => {});
          const body = await readPage.content();
          await readCtx.close().catch(() => {});
          if (body.indexOf(sentinel) !== -1) {
            results.persistence = { attempted: true, proven: true, reason: 'sentinel_survived_fresh_context', sentinel };
          } else {
            results.persistence = { attempted: true, proven: false, reason: 'sentinel_gone_after_reload', sentinel };
          }
        }
      }
    } catch (e) {
      // A create path was found but the drive errored -> proven:false (BLOCK).
      // "submit errored" is the #1 churn bug and must not green-wash.
      results.persistence = { attempted: true, proven: false, reason: 'drive_error: ' + String(e.message).slice(0, 120) };
    }

    // ---- AUTH (negative path) ----
    try {
      // Detect an auth signal: a configured protected path, or a login/signin
      // route/link in the app.
      let path = protectedPath;
      let authSignal = !!protectedPath;
      if (!authSignal) {
        // Re-load the app root (persistence may have navigated it) and look.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeout }).catch(() => {});
        const hasLogin = await page.$('a[href*="login"], a[href*="signin"], a:has-text("Log in"), a:has-text("Login"), a:has-text("Sign in"), form[action*="login"], input[type="password"]').catch(() => null);
        authSignal = !!hasLogin;
        // Guess a protected path from common conventions.
        if (authSignal) {
          for (const cand of ['/dashboard', '/account', '/admin', '/app', '/settings', '/profile']) {
            path = cand; break;
          }
        }
      }

      if (!authSignal) {
        results.auth = { attempted: false, proven: false, reason: 'no_auth' };
      } else if (!path) {
        results.auth = { attempted: false, proven: false, reason: 'auth_detected_untestable' };
      } else {
        results.auth.attempted = true;
        // Logged-out request in a FRESH context (no cookies/storage).
        const ctx = await browser.newContext();
        const p2 = await ctx.newPage();
        const target = new URL(path, url).toString();
        let observed = 'none';
        const resp = await p2.goto(target, { waitUntil: 'domcontentloaded', timeout: pageTimeout }).catch(() => null);
        const status = resp ? resp.status() : 0;
        const finalUrl = p2.url();
        const redirectedToLogin = /login|signin|sign-in|auth/i.test(finalUrl) && finalUrl !== target;
        const hasPasswordField = await p2.$('input[type="password"]').catch(() => null);
        if (status === 401 || status === 403) {
          observed = String(status);
          results.auth = { attempted: true, proven: true, reason: 'rejected_' + status, path, observed_status: status };
        } else if (redirectedToLogin) {
          observed = 'redirect';
          results.auth = { attempted: true, proven: true, reason: 'redirect_to_login', path, observed_status: 'redirect' };
        } else if (status >= 200 && status < 300 && !hasPasswordField) {
          // Protected route served content logged-out -> auth NOT enforced.
          results.auth = { attempted: true, proven: false, reason: 'served_200_logged_out', path, observed_status: status };
        } else if (hasPasswordField) {
          // A login screen merely rendered at the protected path. That is not
          // enforcement of the protected resource; but it is also not a served
          // resource. Treat as untestable (a protected page that IS the login).
          results.auth = { attempted: true, proven: false, reason: 'login_screen_only', path, observed_status: status };
        } else {
          results.auth = { attempted: true, proven: false, reason: 'auth_detected_untestable', path, observed_status: status };
        }
        await ctx.close().catch(() => {});
      }
    } catch (e) {
      results.auth = { attempted: true, proven: false, reason: 'auth_detected_timeout' };
    }

    // ---- AUTHORIZATION (tenant isolation) ----
    // The Lovable-breach class: two LOGGED-IN users where A can read B's owned
    // rows. Prove by OBSERVED artifact only -- a real second session actually
    // being DENIED A's sentinel. The ONLY blocking verdict is a fresh positive
    // leak (reason prefix 'user_b_read_user_a_'); every undetectable/absent case
    // is attempted:false or a non-leak reason -> inconclusive pass-through.
    try {
      // rand sentinel + two distinct identities.
      const rnd = () => Math.random().toString(36).slice(2, 10);
      const sentinel = 'loki-authz-' + rnd();
      const identityA = 'authzA-' + rnd() + '@loki.test';
      const identityB = 'authzB-' + rnd() + '@loki.test';
      const pass = 'Loki-authz-Pw1!';

      // Locate a signup/login form in a page. Returns {user, pass, submit} handles
      // or null. Configured selectors win; else auto-detect a password field + a
      // text/email input + a submit.
      const findAuthForm = async (pg, isSignup) => {
        let userH = null, passH = null, submitH = null;
        if (azUserField) userH = await pg.$(azUserField).catch(() => null);
        if (azPassField) passH = await pg.$(azPassField).catch(() => null);
        if (azSubmitSel) submitH = await pg.$(azSubmitSel).catch(() => null);
        const scopeSel = isSignup ? azSignupSel : azLoginSel;
        if (scopeSel) {
          const scope = await pg.$(scopeSel).catch(() => null);
          if (scope) {
            if (!userH) userH = await scope.$('input[type="email"], input[type="text"], input:not([type])').catch(() => null);
            if (!passH) passH = await scope.$('input[type="password"]').catch(() => null);
            if (!submitH) submitH = await scope.$('button[type="submit"], input[type="submit"], button').catch(() => null);
          }
        }
        if (!passH) passH = await pg.$('input[type="password"]').catch(() => null);
        if (!passH) return null;
        if (!userH) userH = await pg.$('input[type="email"], input[type="text"], input:not([type])').catch(() => null);
        if (!userH) return null;
        if (!submitH) submitH = await pg.$('button[type="submit"], input[type="submit"], button:has-text("Sign up"), button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Register"), button:has-text("Continue")').catch(() => null);
        return { userH, passH, submitH };
      };

      // Authenticate a fresh context as (email). Prefer signup (guarantees a fresh
      // distinct user); fall back to login only if a login form is present.
      // Returns {ctx, page} on success or null.
      const authAs = async (email) => {
        const ctx = await browser.newContext();
        const pg = await ctx.newPage();
        // Try signup route first, then app root.
        let form = null;
        for (const cand of ['/signup', '/register', '/sign-up', '/']) {
          const target = new URL(cand, url).toString();
          await pg.goto(target, { waitUntil: 'domcontentloaded', timeout: pageTimeout }).catch(() => {});
          form = await findAuthForm(pg, true);
          if (form) break;
        }
        if (!form) { await ctx.close().catch(() => {}); return null; }
        try {
          await form.userH.fill(email);
          await form.passH.fill(pass);
          if (form.submitH) { await form.submitH.click().catch(() => {}); }
          else { await form.passH.press('Enter').catch(() => {}); }
          await pg.waitForLoadState('networkidle', { timeout: pageTimeout }).catch(() => {});
          await pg.waitForTimeout(reloadWaitMs);
        } catch (e) { await ctx.close().catch(() => {}); return null; }
        return { ctx, page: pg };
      };

      // Step 1a: two-session capability. If neither configured nor an auto signup
      // path exists, this authAs returns null and we bail as no_multiuser_auth.
      const sessA = await authAs(identityA);
      if (!sessA) {
        results.authorization = { attempted: false, proven: false, reason: 'no_multiuser_auth', identity_a: identityA };
      } else {
        // Step 1b + 2: as A, create an owned record with the sentinel (reuse the
        // persistence create-path finder shape).
        const pgA = sessA.page;
        let createInput = null;
        let formHandleA = null;
        if (createSelector) formHandleA = await pgA.$(createSelector).catch(() => null);
        if (!formHandleA) {
          const trig = await pgA.$('button:has-text("Add"), button:has-text("Create"), button:has-text("New"), a:has-text("Add"), a:has-text("Create")').catch(() => null);
          if (trig) { await trig.click().catch(() => {}); await pgA.waitForTimeout(300); }
          formHandleA = await pgA.$('form').catch(() => null);
        }
        if (formHandleA) createInput = await formHandleA.$('input[type="text"], input:not([type]), input[type="search"], textarea').catch(() => null);
        if (!createInput) createInput = await pgA.$('input[type="text"], input:not([type]), textarea').catch(() => null);

        if (!createInput) {
          results.authorization = { attempted: false, proven: false, reason: 'no_owned_data', identity_a: identityA };
          await sessA.ctx.close().catch(() => {});
        } else {
          await createInput.fill(sentinel);
          const submitBtnA = formHandleA
            ? await formHandleA.$('button[type="submit"], input[type="submit"], button:has-text("Add"), button:has-text("Create"), button:has-text("Save"), button:has-text("Submit")').catch(() => null)
            : null;
          try {
            if (submitBtnA) await submitBtnA.click();
            else await createInput.press('Enter');
          } catch (e) {}
          await pgA.waitForLoadState('networkidle', { timeout: pageTimeout }).catch(() => {});
          await pgA.waitForTimeout(reloadWaitMs);
          // Capture the list route A saw and any detail URL/id after create.
          const listRouteA = azOwnedListSel ? '' : new URL(pgA.url(), url).pathname;
          const afterCreateUrl = pgA.url();
          // Extract a plausible record id from the post-create URL (/items/123).
          let recordId = '';
          const idMatch = afterCreateUrl.match(/\/(\d+|[0-9a-f]{8,})(?:[/?#].*)?$/i);
          if (idMatch) recordId = idMatch[1];
          const detailUrlA = (afterCreateUrl !== url && /\/(\d+|[0-9a-f]{8,})/.test(afterCreateUrl)) ? afterCreateUrl : '';
          await sessA.ctx.close().catch(() => {});

          // Step 3: session B in a SEPARATE fresh context.
          const sessB = await authAs(identityB);
          if (!sessB) {
            results.authorization = { attempted: false, proven: false, reason: 'could_not_create_second_user', sentinel, identity_a: identityA, identity_b: identityB };
          } else {
            const pgB = sessB.page;
            // Distinctness guard: if B's initial view already shows A's sentinel
            // as a BASELINE (single-user app silently reused A), we cannot tell a
            // leak from a shared store -> inconclusive.
            const baselineB = await pgB.content().catch(() => '');
            if (baselineB.indexOf(sentinel) !== -1) {
              results.authorization = { attempted: false, proven: false, reason: 'could_not_create_second_user', sentinel, identity_a: identityA, identity_b: identityB };
              await sessB.ctx.close().catch(() => {});
            } else {
              // Step 4: as B, attempt to READ A's sentinel via every path.
              const pathsTried = [];
              let leakPath = '';

              // (a) list view: the configured owned-list route, else the route A saw.
              let listTarget = '';
              if (azOwnedListSel && /^https?:|^\//.test(azOwnedListSel)) listTarget = azOwnedListSel;
              else if (listRouteA) listTarget = listRouteA;
              if (listTarget) {
                const t = new URL(listTarget, url).toString();
                const r = await pgB.goto(t, { waitUntil: 'networkidle', timeout: pageTimeout }).catch(() => null);
                const st = r ? r.status() : 0;
                let contained = false;
                try {
                  // If configured, scope the read to the owned-list selector.
                  if (azOwnedListSel && !/^https?:|^\//.test(azOwnedListSel)) {
                    const el = await pgB.$(azOwnedListSel).catch(() => null);
                    const txt = el ? await el.textContent().catch(() => '') : await pgB.content().catch(() => '');
                    contained = (txt || '').indexOf(sentinel) !== -1;
                  } else {
                    contained = (await pgB.content().catch(() => '')).indexOf(sentinel) !== -1;
                  }
                } catch (e) {}
                pathsTried.push({ path: 'list', target: t, observed_status: st, contained_sentinel: contained });
                if (contained) leakPath = leakPath || 'list';
              }

              // (b) direct object (IDOR): a detail URL/template navigated in B's ctx.
              let detailTarget = '';
              if (azDetailTemplate && recordId) detailTarget = azDetailTemplate.replace('{id}', recordId);
              else if (detailUrlA) detailTarget = detailUrlA;
              if (detailTarget) {
                const t = new URL(detailTarget, url).toString();
                const r = await pgB.goto(t, { waitUntil: 'domcontentloaded', timeout: pageTimeout }).catch(() => null);
                const st = r ? r.status() : 0;
                const body = await pgB.content().catch(() => '');
                const contained = st >= 200 && st < 300 && body.indexOf(sentinel) !== -1;
                pathsTried.push({ path: 'detail', target: t, observed_status: st, contained_sentinel: contained });
                if (contained) leakPath = leakPath || 'detail';
              }

              // (c) API: configured template in B's cookie context via fetch.
              let apiTarget = '';
              if (azApiTemplate) apiTarget = azApiTemplate.replace('{id}', recordId || '');
              if (apiTarget) {
                const t = new URL(apiTarget, url).toString();
                let st = 0, body = '';
                try {
                  const resp = await pgB.request.get(t, { timeout: pageTimeout });
                  st = resp.status();
                  body = await resp.text().catch(() => '');
                } catch (e) {}
                const contained = st >= 200 && st < 300 && body.indexOf(sentinel) !== -1;
                pathsTried.push({ path: 'api', target: t, observed_status: st, contained_sentinel: contained });
                if (contained) leakPath = leakPath || 'api';
              }

              await sessB.ctx.close().catch(() => {});

              // Step 5: verdict.
              if (pathsTried.length === 0) {
                // Created data but no list/detail/api to read it as B. INCONCLUSIVE.
                results.authorization = { attempted: true, proven: false, reason: 'no_read_path_for_b', sentinel, identity_a: identityA, identity_b: identityB, paths_tried: pathsTried };
              } else if (leakPath) {
                // POSITIVE LEAK: B's real session received A's sentinel. The ONLY block.
                results.authorization = { attempted: true, proven: false, reason: 'user_b_read_user_a_' + leakPath, sentinel, identity_a: identityA, identity_b: identityB, paths_tried: pathsTried };
              } else {
                // Isolation HOLDS: B was denied on every path actually tried.
                results.authorization = { attempted: true, proven: true, reason: 'isolated_on_all_paths', sentinel, identity_a: identityA, identity_b: identityB, paths_tried: pathsTried };
              }
            }
          }
        }
      }
    } catch (e) {
      // Deliberate asymmetry vs persistence: our own driver error is NOT a proof
      // of a leak. Map to inconclusive (the gate treats authz_drive_error:* as
      // pass-through). A security property must never be DISPROVEN by our tooling.
      results.authorization = { attempted: true, proven: false, reason: 'authz_drive_error: ' + String(e && e.message || e).slice(0, 120) };
    }

  } catch (err) {
    // Two inconclusive-passthrough cases land here, both non-blocking:
    //   - the playwright driver could not be required/launched -> driver_unavailable
    //   - the app was unreachable at all -> not_serveable
    const msg = String(err && err.message || err);
    const driverGone = /Cannot find module 'playwright'|Cannot find package 'playwright'|playwright.*not.*found|browserType.launch/i.test(msg);
    const reason = driverGone ? 'driver_unavailable' : 'not_serveable';
    results.persistence = { attempted: false, proven: false, reason };
    results.auth = { attempted: false, proven: false, reason };
    results.authorization = { attempted: false, proven: false, reason };
    results.error = msg.slice(0, 160);
  } finally {
    if (browser) await browser.close();
    write();
  }

  process.exit(0);
})();
PROOF_SCRIPT

    # Run with outer timeout (never block iteration). A timeout leaves NO proof
    # (we deleted the prior file above and the script only writes in its finally);
    # a hung app therefore reads as inconclusive, never as a stale green.
    timeout "${PLAYWRIGHT_TIMEOUT_SEC}" \
        env LOKI_PROOF_ITER="$_proof_iter" LOKI_PROOF_HEAD="$_proof_head" \
        node "$script_file" \
        "$url" "$results_file" "$PLAYWRIGHT_TIMEOUT" 2>/dev/null
    local exit_code=$?

    rm -f "$script_file"

    if [ "$exit_code" -eq 124 ]; then
        log_warn "Playwright functional proof timed out after ${PLAYWRIGHT_TIMEOUT_SEC}s (proof left inconclusive)"
    elif [ -f "$results_file" ]; then
        local psummary
        psummary=$(_PF="$results_file" python3 -c "
import json, os
try:
    d = json.load(open(os.environ['_PF']))
    p = d.get('persistence', {}); a = d.get('auth', {}); z = d.get('authorization', {})
    print('persistence attempted=%s proven=%s (%s) | auth attempted=%s proven=%s (%s) | authz attempted=%s proven=%s (%s)' % (
        p.get('attempted'), p.get('proven'), p.get('reason'),
        a.get('attempted'), a.get('proven'), a.get('reason'),
        z.get('attempted'), z.get('proven'), z.get('reason')))
except Exception:
    print('')
" 2>/dev/null || true)
        [ -n "$psummary" ] && log_info "Playwright functional proof: $psummary"
    fi

    return 0
}

#===============================================================================
# Screenshot Rotation
#===============================================================================

_playwright_rotate_screenshots() {
    local dir="$1"
    local max=${PLAYWRIGHT_MAX_SCREENSHOTS}

    # Count existing screenshots
    local count
    count=$(find "$dir" -maxdepth 1 -name 'verify-*.png' 2>/dev/null | wc -l | tr -d ' ')

    if [ "$count" -gt "$max" ]; then
        local to_remove=$((count - max))
        # Remove oldest files (sorted by name, which is timestamp-based)
        find "$dir" -maxdepth 1 -name 'verify-*.png' 2>/dev/null \
            | sort | head -n "$to_remove" \
            | xargs rm -f 2>/dev/null || true
    fi
}

#===============================================================================
# Summary (for prompt injection)
#===============================================================================

playwright_verify_summary() {
    # Returns one-line summary string
    if [ ! -f "$PLAYWRIGHT_RESULTS_FILE" ]; then
        echo ""
        return 0
    fi

    _PW_RESULTS="$PLAYWRIGHT_RESULTS_FILE" python3 -c "
import json, os
try:
    data = json.load(open(os.environ['_PW_RESULTS']))
    checks = data.get('checks', {})
    passed = sum(1 for v in checks.values() if v)
    total = len(checks)
    status = 'PASS' if data.get('passed') else 'FAIL'
    duration = data.get('duration_ms', 0)
    url = data.get('url', '?')
    errors = data.get('errors', [])
    err_detail = ''
    if errors:
        err_detail = ' Errors: ' + '; '.join(errors[:3])
    print(f'{status} {passed}/{total} checks ({duration}ms) {url}{err_detail}')
except Exception:
    print('')
" 2>/dev/null || echo ""
}

#===============================================================================
# Council Evidence (for completion-council.sh)
#===============================================================================

playwright_verify_as_evidence() {
    # Writes formatted smoke test evidence to stdout or appends to file
    local evidence_file="${1:-}"

    if [ ! -f "$PLAYWRIGHT_RESULTS_FILE" ]; then
        return 0
    fi

    {
        echo ""
        echo "## Playwright Smoke Test"
        echo ""

        _PW_RESULTS="$PLAYWRIGHT_RESULTS_FILE" python3 -c "
import json, os
try:
    data = json.load(open(os.environ['_PW_RESULTS']))
    checks = data.get('checks', {})
    status = 'PASS' if data.get('passed') else 'FAIL'
    print(f'Overall: {status} | URL: {data.get(\"url\", \"?\")} | Duration: {data.get(\"duration_ms\", 0)}ms')
    print()
    for name, result in checks.items():
        label = '[PASS]' if result else '[FAIL]'
        print(f'  {label} {name}')
    errors = data.get('errors', [])
    if errors:
        print()
        print('Errors:')
        for e in errors[:5]:
            print(f'  - {e}')
    screenshot = data.get('screenshot', '')
    if screenshot:
        print()
        print(f'Screenshot: {screenshot}')
except Exception:
    print('Playwright data unavailable')
" 2>/dev/null || echo "Playwright data unavailable"
    } >> "${evidence_file:-/dev/stdout}"
}
