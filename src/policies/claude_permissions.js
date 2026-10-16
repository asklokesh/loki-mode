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
        return section(env.LOKI_DATA_DIR || path.join(env.HOME || '', '.loki')) !== null;
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

    // Deny always wins over allow; drop duplicate deny entries.
    deny = deny.filter(function (d, j) { return deny.indexOf(d) === j; });
    allow = allow.filter(function (a) { return deny.indexOf(a) < 0; });
    var args = ['--permission-mode', mode];
    if (allow.length) args.push('--allowedTools', allow.join(','));
    if (deny.length) args.push('--disallowedTools', deny.join(','));
    return { args: args, warnings: warnings };
}

module.exports = { compile: compile, hasOperatorPolicy: hasOperatorPolicy };

if (require.main === module && process.argv[2] === '--has-operator-policy') {
    process.stdout.write(hasOperatorPolicy(process.env) ? '1\n' : '0\n');
} else if (require.main === module) {
    var r = compile(process.argv[2] || process.env.LOKI_PROJECT_DIR || process.cwd(), process.env);
    r.warnings.forEach(function (w) { process.stderr.write('[loki] WARNING: ' + w + '\n'); });
    process.stdout.write(r.args.join('\n') + '\n'); // rules reject newlines, so one arg per line is safe
}
