# Agent 13 - Enterprise Bug Fixes

Bugs discovered during enterprise scenario writing. Each includes root cause
analysis, affected files, and applied fix (where applicable).

---

## BUG-E01: Helm Chart appVersion Severely Out of Date

**Severity:** Medium
**Status:** Fixed

**Description:**
The Helm chart `Chart.yaml` has `appVersion: "5.52.0"` while the actual product
version is `6.71.1`. This means `helm install` without an explicit `--set image.tag`
will pull the Docker image tagged `5.52.0`, which is 119+ minor versions behind.
The `_helpers.tpl` `autonomi.image` template defaults to `Chart.appVersion` when
`image.tag` is empty, so this directly affects production deployments.

**Root Cause:**
The Helm chart `appVersion` is not included in the 14-location version bump
checklist in CLAUDE.md. It has drifted since the chart was first created.

**Affected Files:**
- `deploy/helm/autonomi/Chart.yaml` (line 6)

**Fix Applied:**
Updated `appVersion` from `"5.52.0"` to `"6.71.1"`.

---

## BUG-E02: automountServiceAccountToken Conflict

**Severity:** Low
**Status:** Documented (intentional override but inconsistent intent)

**Description:**
The ServiceAccount template (`serviceaccount.yaml:12`) sets
`automountServiceAccountToken: false` (security best practice -- do not mount
the SA token unless needed). However, the controlplane deployment template
(`deployment-controlplane.yaml:29`) explicitly sets
`automountServiceAccountToken: true` at the pod spec level. The pod-level
setting overrides the SA-level setting, so the token IS mounted in controlplane
pods.

The worker deployment does NOT set `automountServiceAccountToken` at the pod
level, so it inherits the SA-level `false` setting. This means:
- Controlplane pods: SA token IS mounted (explicit true)
- Worker pods: SA token is NOT mounted (inherits SA false)

This is likely intentional (controlplane needs K8s API access for the RBAC role
to query pods/logs/configmaps/events), but the inconsistency should be
documented. If the controlplane needs the token, the SA-level `false` is
misleading.

**Affected Files:**
- `deploy/helm/autonomi/templates/serviceaccount.yaml` (line 12)
- `deploy/helm/autonomi/templates/deployment-controlplane.yaml` (line 29)

**Recommendation:**
Add a comment in `serviceaccount.yaml` explaining that the controlplane
overrides this at the pod level. Alternatively, make the SA-level setting
configurable via values.yaml.

---

## BUG-E03: Agent Card Reports "sso": false Despite OIDC Implementation

**Severity:** Low
**Status:** Fixed

**Description:**
The A2A Agent Card endpoint (`GET /.well-known/agent.json`) in
`dashboard/server.py:516` hardcodes `"sso": False` in the enterprise
capabilities section. However, OIDC/SSO support is fully implemented in
`dashboard/auth.py` with:
- OIDC issuer discovery
- JWKS key fetching and caching
- JWT validation (with PyJWT when available)
- Support for Okta, Azure AD, Google Workspace

The `sso` field should dynamically reflect whether OIDC is configured.

**Affected Files:**
- `dashboard/server.py` (line 516)

**Fix Applied:**
Changed `"sso": False` to `"sso": auth.is_oidc_mode()` so the agent card
accurately reflects the current OIDC configuration state.

---

## BUG-E04: Worker Deployment Missing Audit Logs Volume Mount

**Severity:** Low
**Status:** Documented

**Description:**
The controlplane deployment mounts both `checkpoints` and `audit-logs` volumes
(lines 79-86 in deployment-controlplane.yaml). The worker deployment only
mounts `checkpoints` (lines 73-77 in deployment-worker.yaml). If workers
perform any audit-worthy actions that write to the audit log path
(`/data/audit/audit.log`), those writes will fail silently or go to the
ephemeral container filesystem.

This may be intentional (only the controlplane/dashboard writes audit logs),
but if RARV iteration actions should be audited at the worker level, the
volume mount is needed.

**Affected Files:**
- `deploy/helm/autonomi/templates/deployment-worker.yaml` (missing audit volume mount)

**Recommendation:**
If workers should write audit logs, add the audit-logs volume mount. If only
the controlplane audits, add a comment in the worker template explaining the
intentional omission.

---

## BUG-E05: Helm Test test-health.yaml Expects python3 in curl Image

**Severity:** Medium
**Status:** Fixed

**Description:**
The Helm test `test-health.yaml` uses the `curlimages/curl:8.5.0` image and
attempts to pipe the API response through `python3 -c "import sys, json;
json.load(sys.stdin)"`. The `curlimages/curl` image is Alpine-based and does
NOT include Python. The test will always fail at the JSON validation step.

The fallback `grep -q '{'` check partially compensates, but the logic flow is
incorrect: the `||` chain means it tries python3 first, and if python3 is not
found (exit code 127), it falls through to grep. This works accidentally but
is fragile and misleading.

**Affected Files:**
- `deploy/helm/autonomi/tests/test-health.yaml` (line 22-23)

**Fix Applied:**
Replaced the python3 JSON validation with a pure-shell approach that only uses
tools available in the curl image (grep for JSON structure verification).

---
