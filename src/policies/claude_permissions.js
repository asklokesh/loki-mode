#!/usr/bin/env node
'use strict';
// P12-26: compile the task policy into Claude permission flags. One rule shared by the
// bash route (CLI mode, one argv entry per line on stdout) and the TS route (require).
// New file: src/policies owns policy semantics; check.js is a gate, not a flag compiler.
// Policy shape (policies.json, under "policies" or top level):
//   "claude_permissions": { "mode": "plan|default|acceptEdits|bypassPermissions", "allow": [..], "deny": [..] }
// The operator's ~/.loki policy and the repo .loki policy are both read; the repo file
// may only NARROW the operator's (min mode, intersected allow, unioned deny).
var fs = require('fs');
var path = require('path');

var MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions']; // most restrictive first
var MOST_RESTRICTIVE = 'plan';
var NO_POLICY_MODE = 'acceptEdits'; // headless 'default' is near read-only
var MANAGED_DEFAULTS = [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/etc/claude-code/managed-settings.json'
];

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function strList(v) {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error('allow/deny must be arrays');
    v.forEach(function (x) { if (typeof x !== 'string' || !x || /[,\n\0]/.test(x)) throw new Error('invalid tool rule'); });
    return v;
}
function failClosed(why, warnings) {
    warnings.push('LOKI_PERMISSION_POLICY=compiled: ' + why + '; using most restrictive mode (' + MOST_RESTRICTIVE + ')');
    return { args: ['--permission-mode', MOST_RESTRICTIVE], warnings: warnings };
}
// Default web and credential rules (w2-07). Web tools are denied unless the operator opts in:
// LOKI_WEB_ALLOW_DOMAINS (comma list, ASCII hostnames only) allows WebFetch for those domains;
// an operator allow entry for WebFetch/WebSearch also keeps that tool; LOKI_WEB_POLICY=off
// restores the old behavior (no default web or credential rules).
// '//' anchors a rule at the filesystem root; a bare '**/' form matches only under the cwd, which would leave
// ~/.aws, ~/.ssh and .env or .pem files outside the repo readable.
// Read denies use the bare '.env*' glob on purpose: a deny beats any allow, so a name list cannot carve out
// the templates (.env.example, .env.sample, .env.template) without missing secret names such as .envrc,
// .env.prod, .env.keys, .env.vault and .env.bak. The templates are blocked too.
// The list lives in autonomy/lib/secret-paths.json, shared with the OS sandbox (autonomy/lib/os_sandbox.py).
var CRED_DENY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'autonomy', 'lib', 'secret-paths.json'), 'utf8'))
    .rules.map(function (r) { return r.kind === 'file' ? 'Read(//**/' + r.glob + ')' : 'Read(//**/' + r.name + '/**)'; });
var HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// Throws on any non-ASCII, malformed or punycode (xn-- label) domain: an ASCII xn-- name can render as a
// look-alike of another site, so IDN hosts are rejected outright.
function parseWebAllowDomains(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return [];
    return String(raw).split(',').map(function (d) { return d.trim(); }).filter(Boolean).map(function (d) {
        if (/[^\x21-\x7e]/.test(d)) throw new Error('LOKI_WEB_ALLOW_DOMAINS: non-ASCII domain rejected');
        if (/(^|\.)xn--/i.test(d)) throw new Error('LOKI_WEB_ALLOW_DOMAINS: punycode (xn--) domain rejected');
        if (!HOST_RE.test(d)) throw new Error('LOKI_WEB_ALLOW_DOMAINS: invalid domain ' + JSON.stringify(d));
        return d.toLowerCase();
    });
}
function webPolicyOff(env) { return (env.LOKI_WEB_POLICY || '').toLowerCase() === 'off'; }
function startsWith(list, prefix) { return list.some(function (a) { return a === prefix || a.indexOf(prefix + '(') === 0; }); }

// Default rules for the compiled route: { allow, deny } to add given the operator allow list.
function defaultWebRules(env, allow) {
    if (webPolicyOff(env)) return { allow: [], deny: [] };
    var domains = parseWebAllowDomains(env.LOKI_WEB_ALLOW_DOMAINS);
    var addAllow = domains.map(function (d) { return 'WebFetch(domain:' + d + ')'; });
    var deny = [];
    if (!domains.length && !startsWith(allow, 'WebFetch')) deny.push('WebFetch');
    if (!startsWith(allow, 'WebSearch')) deny.push('WebSearch');
    return { allow: addAllow, deny: deny.concat(CRED_DENY) };
}

// Legacy (bypass) route: a deny rule beats any allow, so a domain allowlist cannot be
// expressed there; both web tools stay denied and a warning says how to enable it.
function legacyArgs(env) {
    env = env || process.env;
    var warnings = [];
    if (webPolicyOff(env)) return { args: ['--dangerously-skip-permissions'], warnings: warnings };
    var domains;
    try { domains = parseWebAllowDomains(env.LOKI_WEB_ALLOW_DOMAINS); } catch (e) {
        // Fail closed like compile(): an unusable web policy never degrades to plain bypass.
        warnings.push('legacy web policy: invalid web policy (' + e.message + '); using most restrictive mode (' + MOST_RESTRICTIVE + ')');
        return { args: ['--permission-mode', MOST_RESTRICTIVE], warnings: warnings };
    }
    if (domains.length) {
        warnings.push('LOKI_WEB_ALLOW_DOMAINS is enforced only with LOKI_PERMISSION_POLICY=compiled; the legacy route keeps WebFetch and WebSearch denied');
    }
    return { args: ['--dangerously-skip-permissions', '--disallowedTools', ['WebFetch', 'WebSearch'].concat(CRED_DENY).join(',')], warnings: warnings };
}

function lower(a, b) { return MODES.indexOf(a) <= MODES.indexOf(b) ? a : b; }

// Section of one policies.json in dir: null when there is no file or no section; throws when unusable.
function section(dir) {
    var js = path.join(dir, 'policies.json');
    if (!fs.existsSync(js)) {
        if (fs.existsSync(path.join(dir, 'policies.yaml'))) throw new Error('policies.yaml cannot be compiled (use policies.json)');
        return null;
    }
    var parsed = readJson(js);
    var pol = (parsed && parsed.policies) || parsed;
    var cp = pol && pol.claude_permissions;
    if (cp === undefined) return null;
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) throw new Error('claude_permissions must be an object');
    if (cp.mode !== undefined && MODES.indexOf(cp.mode) < 0) throw new Error('unknown mode ' + JSON.stringify(cp.mode));
    return { mode: cp.mode, allow: cp.allow === undefined ? null : strList(cp.allow), deny: strList(cp.deny) };
}

// True when an operator claude_permissions policy exists (same check compile() uses). An
// unusable policy counts as present so the caller fails closed. Decides the unset default.
function hasOperatorPolicy(env) {
    env = env || process.env;
    try {
        var dir = env.LOKI_DATA_DIR || path.join(env.HOME || '', '.loki');
        // yaml-only: the file may hold other policies (cost); only a claude_permissions key counts.
        if (!fs.existsSync(path.join(dir, 'policies.json')) && fs.existsSync(path.join(dir, 'policies.yaml'))) {
            return /^\s*claude_permissions\s*:/m.test(fs.readFileSync(path.join(dir, 'policies.yaml'), 'utf8'));
        }
        return section(dir) !== null;
    } catch (e) {
        return true;
    }
}

function compile(repoDir, env) {
    env = env || process.env;
    var warnings = [];
    var mode = NO_POLICY_MODE, allow = null, deny = [];
    try {
        var dataDir = env.LOKI_DATA_DIR || path.join(env.HOME || '', '.loki');
        // The operator policy is the base (none: acceptEdits with an empty allow list; an
        // operator policy without "allow" also means an empty allow list, not unlimited).
        // The repo policy may only narrow it: lower mode, allow intersected, deny unioned.
        var op = section(dataDir), repo = section(path.join(repoDir, '.loki'));
        allow = [];
        if (op) {
            mode = op.mode === undefined ? 'default' : op.mode;
            allow = op.allow || [];
            deny = op.deny;
        } else {
            warnings.push('LOKI_PERMISSION_POLICY=compiled: no operator claude_permissions policy found; using ' + NO_POLICY_MODE +
                (repo ? ' (a repo policy can only narrow it)' : ''));
        }
        if (repo) {
            if (repo.mode !== undefined) mode = lower(mode, repo.mode);
            if (repo.allow !== null) allow = allow.filter(function (a) { return repo.allow.indexOf(a) >= 0; });
            deny = deny.concat(repo.deny);
        }
    } catch (e) {
        return failClosed('invalid policy (' + e.message + ')', warnings);
    }

    // Managed settings: never pass a mode more permissive than the managed cap.
    var mpaths = env.LOKI_MANAGED_SETTINGS ? [env.LOKI_MANAGED_SETTINGS] : MANAGED_DEFAULTS;
    for (var i = 0; i < mpaths.length; i++) {
        if (!fs.existsSync(mpaths[i])) continue;
        try {
            var perms = readJson(mpaths[i]).permissions;
            if (perms && typeof perms === 'object') {
                var cap = null;
                if (perms.defaultMode !== undefined) {
                    if (MODES.indexOf(perms.defaultMode) < 0) throw new Error('unknown managed defaultMode');
                    cap = perms.defaultMode;
                }
                if (perms.disableBypassPermissionsMode === 'disable') cap = cap === null ? 'acceptEdits' : lower(cap, 'acceptEdits');
                if (cap !== null) mode = lower(mode, cap);
                deny = deny.concat(strList(perms.deny));
            }
        } catch (e) {
            return failClosed('unreadable managed settings (' + e.message + ')', warnings);
        }
    }

    try {
        var web = defaultWebRules(env, allow);
        allow = allow.concat(web.allow);
        deny = deny.concat(web.deny);
    } catch (e) {
        return failClosed('invalid web policy (' + e.message + ')', warnings);
    }

    // Deny always wins over allow; drop duplicate deny entries.
    deny = deny.filter(function (d, j) { return deny.indexOf(d) === j; });
    allow = allow.filter(function (a) { return deny.indexOf(a) < 0; });
    var args = ['--permission-mode', mode];
    if (allow.length) args.push('--allowedTools', allow.join(','));
    if (deny.length) args.push('--disallowedTools', deny.join(','));
    return { args: args, warnings: warnings };
}

module.exports = { compile: compile, hasOperatorPolicy: hasOperatorPolicy, legacyArgs: legacyArgs, parseWebAllowDomains: parseWebAllowDomains };

if (require.main === module && process.argv[2] === '--has-operator-policy') {
    process.stdout.write(hasOperatorPolicy(process.env) ? '1\n' : '0\n');
} else if (require.main === module && process.argv[2] === '--legacy-args') {
    var lg = legacyArgs(process.env);
    lg.warnings.forEach(function (w) { process.stderr.write('[loki] WARNING: ' + w + '\n'); });
    process.stdout.write(lg.args.join('\n') + '\n');
} else if (require.main === module) {
    var r = compile(process.argv[2] || process.env.LOKI_PROJECT_DIR || process.cwd(), process.env);
    r.warnings.forEach(function (w) { process.stderr.write('[loki] WARNING: ' + w + '\n'); });
    process.stdout.write(r.args.join('\n') + '\n'); // rules reject newlines, so one arg per line is safe
}
