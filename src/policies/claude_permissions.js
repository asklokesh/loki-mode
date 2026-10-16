#!/usr/bin/env node
'use strict';
// P12-26: compile the task policy into Claude permission flags. One rule shared by the
// bash route (CLI mode, one argv entry per line on stdout) and the TS route (require).
// New file: src/policies owns policy semantics; check.js is a gate, not a flag compiler.
// Policy shape (policies.json, under "policies" or top level):
//   "claude_permissions": { "mode": "plan|default|acceptEdits|bypassPermissions", "allow": [..], "deny": [..] }
var fs = require('fs');
var path = require('path');

var MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions']; // most restrictive first
var MOST_RESTRICTIVE = 'plan';
var MANAGED_DEFAULT = '/Library/Application Support/ClaudeCode/managed-settings.json';

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

function findPolicy(repoDir, env) {
    var dataDir = env.LOKI_DATA_DIR || path.join(env.HOME || '', '.loki');
    var dirs = [path.join(repoDir, '.loki'), dataDir];
    for (var i = 0; i < dirs.length; i++) {
        var js = path.join(dirs[i], 'policies.json');
        var ym = path.join(dirs[i], 'policies.yaml');
        if (fs.existsSync(js)) return js;
        if (fs.existsSync(ym)) return ym;
    }
    return null;
}

function compile(repoDir, env) {
    env = env || process.env;
    var warnings = [];
    var mode = 'default', allow = [], deny = [];
    try {
        var pf = findPolicy(repoDir, env);
        if (pf) {
            if (!/\.json$/.test(pf)) return failClosed('policies.yaml cannot be compiled (use policies.json)', warnings);
            var parsed = readJson(pf);
            var pol = (parsed && parsed.policies) || parsed;
            var cp = pol && pol.claude_permissions;
            if (cp !== undefined) {
                if (!cp || typeof cp !== 'object' || Array.isArray(cp)) throw new Error('claude_permissions must be an object');
                if (cp.mode !== undefined) {
                    if (MODES.indexOf(cp.mode) < 0) throw new Error('unknown mode ' + JSON.stringify(cp.mode));
                    mode = cp.mode;
                }
                allow = strList(cp.allow);
                deny = strList(cp.deny);
            }
        }
    } catch (e) {
        return failClosed('invalid policy (' + e.message + ')', warnings);
    }

    // Managed settings: never pass a mode more permissive than the managed cap.
    var mpath = env.LOKI_MANAGED_SETTINGS || MANAGED_DEFAULT;
    if (fs.existsSync(mpath)) {
        try {
            var perms = readJson(mpath).permissions;
            if (perms && typeof perms === 'object') {
                var cap = null;
                if (perms.defaultMode !== undefined) {
                    if (MODES.indexOf(perms.defaultMode) < 0) throw new Error('unknown managed defaultMode');
                    cap = perms.defaultMode;
                }
                if (perms.disableBypassPermissionsMode === 'disable' &&
                    (cap === null || MODES.indexOf(cap) > MODES.indexOf('acceptEdits'))) cap = 'acceptEdits';
                if (cap !== null && MODES.indexOf(mode) > MODES.indexOf(cap)) mode = cap;
                deny = deny.concat(strList(perms.deny));
            }
        } catch (e) {
            return failClosed('unreadable managed settings (' + e.message + ')', warnings);
        }
    }

    // Deny always wins over allow.
    allow = allow.filter(function (a) { return deny.indexOf(a) < 0; });
    var args = ['--permission-mode', mode];
    if (allow.length) args.push('--allowedTools', allow.join(','));
    if (deny.length) args.push('--disallowedTools', deny.join(','));
    return { args: args, warnings: warnings };
}

module.exports = { compile: compile };

if (require.main === module) {
    var r = compile(process.argv[2] || process.env.LOKI_PROJECT_DIR || process.cwd(), process.env);
    r.warnings.forEach(function (w) { process.stderr.write('[loki] WARNING: ' + w + '\n'); });
    process.stdout.write(r.args.join('\n') + '\n'); // rules reject newlines, so one arg per line is safe
}
