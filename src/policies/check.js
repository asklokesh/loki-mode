#!/usr/bin/env node
'use strict';

var PolicyEngine = require('./engine').PolicyEngine;

var enforcementPoint = process.argv[2];
if (!enforcementPoint) {
    process.stderr.write('Usage: node check.js <enforcement_point> [context_json]\n');
    process.exit(1);
}

var context = {};
if (process.argv[3]) {
    try {
        context = JSON.parse(process.argv[3]);
    } catch (e) {
        process.stderr.write('Invalid context JSON: ' + e.message + '\n');
        process.exit(1);
    }
}

var projectDir = process.env.LOKI_PROJECT_DIR || process.cwd();
var engine;
try {
    engine = new PolicyEngine(projectDir);
} catch (e) {
    // A security control that cannot instantiate must FAIL CLOSED (deny),
    // never allow by default. An unexpected error here means we cannot make
    // a sound policy decision, so we deny rather than silently disable
    // enforcement.
    process.stdout.write(JSON.stringify({
        allowed: false,
        decision: 'DENY',
        reason: 'Policy engine failed to initialize: ' + e.message,
        requiresApproval: false,
        violations: [],
    }));
    process.stderr.write('Policy engine failed to initialize: ' + e.message + '\n');
    process.exit(1);
}

// Fail-closed on a present-but-unparseable policy file. If a policy file
// exists on disk but could not be loaded (corrupt JSON / bad YAML), the engine
// records the error and leaves _policies null. Falling through to evaluate()
// would return the misleading "No policies configured" ALLOW, silently
// disabling all policy enforcement. A security control that disables itself on
// malformed config is fail-open; deny instead.
if (engine.hasLoadErrors()) {
    var loadErrors = engine.getValidationErrors();
    process.stdout.write(JSON.stringify({
        allowed: false,
        decision: 'DENY',
        reason: 'Policy file present but could not be loaded (fail-closed): ' + loadErrors.join('; '),
        requiresApproval: false,
        violations: [],
    }));
    process.stderr.write('Policy file present but could not be loaded; denying (fail-closed): ' + loadErrors.join('; ') + '\n');
    process.exit(1);
}

var result = engine.evaluate(enforcementPoint, context);
process.stdout.write(JSON.stringify(result));

if (!result.allowed) {
    process.exit(result.requiresApproval ? 2 : 1);
}
process.exit(0);
