#!/usr/bin/env bash
# secret-scan.sh -- RUN-25 iter 21 (Wave D #2): the two-tier secret matcher,
# extracted to ONE sourceable location so the commit-time gate (autonomy/run.sh)
# and the completion EVIDENCE gate (autonomy/completion-council.sh) share a
# single implementation. Previously the matcher lived only in run.sh and ran only
# on the auto-commit path, so a completion-promise / dirty-tree / non-commit route
# could ship a leaked credential in a "done" deliverable -- a hole in the exact
# trust moat Loki sells. Both functions are pure (take a file path); no external
# state. Patterns are kept in lockstep with autonomy/verify.sh verify_secret_scan_file.
#
# No emojis. No em dashes.

_commit_scan_secret_file() {
    # Two-tier secret matcher. Returns 0 if a high-confidence secret is found in
    # the file, 1 otherwise. Patterns copied verbatim from the shipped scanner
    # (autonomy/verify.sh verify_secret_scan_file) so the commit-time gate matches
    # the verification gate's behavior. Top-level (not nested) so tests can
    # override it for the mutation/non-vacuity proof.
    local file="${1:-}"
    [ -n "$file" ] && [ -f "$file" ] || return 1

    # TEMPLATE / FIXTURE PATHS: a file whose NAME declares it is an example is
    # not a leak, it is documentation. `.env.example` shipping
    # `OPENAI_API_KEY=sk-...` is the correct way to show the expected shape, and
    # generated apps produce these routinely. Without this, the completion gate
    # blocks a finished, correct app for shipping its own template -- and the
    # tier1 matcher below deliberately has no deny filter, so the usual
    # example/placeholder escape hatch never gets a chance to apply.
    # Scoped narrowly to paths that ANNOUNCE themselves: *.example, *.sample,
    # *.template, *.dist, and files under a fixtures/ directory. A real secret
    # in a real path is still caught by both tiers.
    case "$file" in
        *.example|*.example.*|*.sample|*.sample.*|*.template|*.template.*|*.dist|*/fixtures/*|*/__fixtures__/*)
            return 1 ;;
    esac

    # TIER 1: specific formats. No deny filter -- a format match is a finding.
    local tier1=(
        'AKIA[0-9A-Z]{16}'                          # AWS access key id
        'ASIA[0-9A-Z]{16}'                          # AWS temporary (STS) key id
        '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----'     # PEM private key block
        'gh[pousr]_[A-Za-z0-9]{36,}'                # GitHub token (ghp_/gho_/...)
        'github_pat_[A-Za-z0-9_]{60,}'              # GitHub fine-grained PAT
        'xox[baprs]-[A-Za-z0-9-]{10,}'              # Slack token (xoxb-/xoxp-/...)
        'sk-[A-Za-z0-9]{20,}'                       # OpenAI-style secret key
        'AIza[0-9A-Za-z_-]{35}'                     # Google API key
        'glpat-[A-Za-z0-9_-]{20,}'                  # GitLab personal access token
    )
    local p
    for p in "${tier1[@]}"; do
        # -e terminates option parsing so a pattern beginning with '-' (the PEM
        # block) is not mistaken for a flag.
        if LC_ALL=C grep -Eq -e "$p" "$file" 2>/dev/null; then
            return 0
        fi
    done

    # Deny filter for TIER 2: a matched line is IGNORED if it is plainly a
    # placeholder or an environment-variable reference rather than a literal.
    local deny='(\$\{|\$[A-Za-z_]|process\.env|os\.(environ|getenv)|%[A-Za-z_]+%|your[-_]|redacted|changeme|change[-_]me|placeholder|example|dummy|sample|fake|<[^>]*>|x{4,}|\*{4,})'

    # TIER 2: generic assignments + bearer tokens + connection-string creds.
    local tier2='(api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+.=-]{16,}'
    local bearer='[Bb]earer[[:space:]]+[A-Za-z0-9_.\-]{20,}'
    # URI-embedded credentials: scheme://user:password@host. The #1 leak vector
    # in 12-factor apps (DATABASE_URL=postgres://u:pass@h, mongodb+srv://, redis://).
    # Runs through the deny filter below, so ${VAR}-ref URIs are correctly ignored.
    # Username segment is optional (*) so the password-only form redis://:pass@host
    # (Redis < 6 / Heroku Redis / Redis Cloud emit exactly this) is caught too.
    local uricred='[a-z][a-z0-9+.\-]*://[^/[:space:]:@]*:[^/[:space:]:@]+@'

    local surviving
    surviving="$(LC_ALL=C grep -EiI "$tier2|$bearer|$uricred" "$file" 2>/dev/null \
        | LC_ALL=C grep -Eiv "$deny" 2>/dev/null)"
    if [ -n "$surviving" ]; then
        return 0
    fi
    return 1
}

_commit_path_looks_secret() {
    # Filename/path heuristic. Returns 0 if the path looks like a credential or
    # secret file ANYWHERE in the tree (basename OR any directory component),
    # 1 otherwise. This is the PRIMARY commit-time guard: it catches likely-secret
    # files regardless of where they sit and regardless of how weak the value
    # inside looks, closing the nested-path gap that a top-level glob (':!credentials*')
    # and a content-pattern scan both miss (e.g. secrets/credentials.json holding
    # {"key":"sk-secret"}). The content scan (_commit_scan_secret_file) remains the
    # complementary layer 2 for strong secrets hiding in non-obvious filenames.
    #
    # Safe-default bias: this runs only for the session-end AUTO-commit. A false
    # positive merely leaves the file uncommitted for the user to commit by hand,
    # which is acceptable and honest. So we err toward caution.
    #
    # Top-level (not nested) so tests can override it for the non-vacuity proof.
    local p="${1:-}"
    [ -n "$p" ] || return 1
    # Case-insensitive match: lower the full path AND the basename, test both.
    local lower base
    lower="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
    base="${lower##*/}"
    local cand
    for cand in "$lower" "$base"; do
        case "$cand" in
            # dotenv files (basename or any path component ending in them)
            .env|.env.*|*/.env|*/.env.*|*.env) return 0 ;;
            # credential(s) anywhere (basename or any segment): secrets/credentials.json,
            # aws-credentials, my-credential.txt, .git-credentials
            *credential*) return 0 ;;
            # a "secret"/"secrets" segment anywhere: secrets/anything, config/secret.json
            *secret*) return 0 ;;
            # private-key / keystore / cert material (extension-anchored so we do
            # NOT match innocuous names like config.js or monkey.js)
            *.pem|*.key|*.p12|*.keystore|*.pfx|*.jks|*.ppk) return 0 ;;
            id_rsa|id_rsa.*|*/id_rsa|*/id_rsa.*) return 0 ;;
            id_ed25519*|*/id_ed25519*) return 0 ;;
            # token files: extension (*.token) OR "token" as a whole word/segment
            # (delimited by /, -, _, or .). Deliberately NOT a bare *token*: that
            # would flag ubiquitous innocuous frontend/parser names (tokenizer.js,
            # tokens.css, design-tokens.json), and since the scan aborts the WHOLE
            # session auto-commit on any single offender, one such file would block
            # committing all of the user's work. Segment-style still catches real
            # token files: api.token, auth_token, id-token, github.token, oauth-token.json.
            *.token) return 0 ;;
            token|token.*|token-*|token_*) return 0 ;;
            *-token|*_token|*.token.*) return 0 ;;
            *-token.*|*_token.*|*/token|*/token.*) return 0 ;;
            *-token-*|*_token_*|*-token_*|*_token-*) return 0 ;;
            # package/registry/cloud credential configs
            .npmrc|*/.npmrc|.pypirc|*/.pypirc|.netrc|*/.netrc) return 0 ;;
            *.kubeconfig|kubeconfig|*/kubeconfig) return 0 ;;
            .dockercfg|*/.dockercfg|.docker/config.json|*/.docker/config.json) return 0 ;;
            # service-account / gcp key json
            service-account*.json|*/service-account*.json|*serviceaccount*) return 0 ;;
            gcp-key*.json|*/gcp-key*.json) return 0 ;;
        esac
    done
    return 1
}
