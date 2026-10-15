'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHECK_SCRIPT = path.resolve(__dirname, '../../src/policies/check.js');

/**
 * Create a temporary project directory with optional .loki/policies.json.
 * Returns the temp directory path. Caller must clean up.
 */
function makeTempProject(policies) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-policy-check-'));
    if (policies !== undefined) {
        const lokiDir = path.join(tmpDir, '.loki');
        fs.mkdirSync(lokiDir, { recursive: true });
        fs.writeFileSync(
            path.join(lokiDir, 'policies.json'),
            JSON.stringify(policies, null, 2),
            'utf8'
        );
    }
    return tmpDir;
}

function runCheck(enforcementPoint, contextJson, projectDir) {
    const args = ['node', CHECK_SCRIPT];
    if (enforcementPoint !== undefined) {
        args.push(enforcementPoint);
    }
    if (contextJson !== undefined) {
        args.push(contextJson);
    }
    const env = Object.assign({}, process.env);
    if (projectDir) {
        env.LOKI_PROJECT_DIR = projectDir;
    }
    return spawnSync(args[0], args.slice(1), {
        env: env,
        encoding: 'utf8',
        timeout: 10000,
    });
}

describe('Policy check CLI (check.js)', function () {
    let tmpDirs = [];

    afterEach(function () {
        for (const d of tmpDirs) {
            fs.rmSync(d, { recursive: true, force: true });
        }
        tmpDirs = [];
    });

    it('exits 0 when no policy file exists', function () {
        const dir = makeTempProject(); // no policies file
        tmpDirs.push(dir);
        const result = runCheck('pre_execution', '{}', dir);
        assert.equal(result.status, 0, 'Expected exit code 0, got ' + result.status);
        const output = JSON.parse(result.stdout);
        assert.equal(output.allowed, true);
        assert.equal(output.decision, 'ALLOW');
    });

    it('exits 0 when policies pass', function () {
        const dir = makeTempProject({
            policies: {
                pre_execution: [
                    {
                        name: 'agent-limit',
                        rule: 'active_agents <= 10',
                        action: 'deny',
                    },
                ],
            },
        });
        tmpDirs.push(dir);
        // Context with active_agents below limit -> should pass
        const ctx = JSON.stringify({ active_agents: 3 });
        const result = runCheck('pre_execution', ctx, dir);
        assert.equal(result.status, 0, 'Expected exit code 0, got ' + result.status);
        const output = JSON.parse(result.stdout);
        assert.equal(output.allowed, true);
    });

    it('exits 1 when a policy denies', function () {
        const dir = makeTempProject({
            policies: {
                pre_execution: [
                    {
                        name: 'agent-limit',
                        rule: 'active_agents <= 3',
                        action: 'deny',
                    },
                ],
            },
        });
        tmpDirs.push(dir);
        // Context with active_agents above limit -> should deny
        const ctx = JSON.stringify({ active_agents: 10 });
        const result = runCheck('pre_execution', ctx, dir);
        assert.equal(result.status, 1, 'Expected exit code 1, got ' + result.status + ' stderr: ' + result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.allowed, false);
        assert.equal(output.decision, 'DENY');
    });

    it('exits 2 when a policy requires approval', function () {
        const dir = makeTempProject({
            policies: {
                resource: [
                    {
                        name: 'token-budget',
                        max_tokens: 1000,
                        on_exceed: 'require_approval',
                        action: 'deny',
                    },
                ],
            },
        });
        tmpDirs.push(dir);
        const ctx = JSON.stringify({ tokens_consumed: 2000 });
        const result = runCheck('resource', ctx, dir);
        assert.equal(result.status, 2, 'Expected exit code 2, got ' + result.status + ' stdout: ' + result.stdout);
        const output = JSON.parse(result.stdout);
        assert.equal(output.allowed, false);
        assert.equal(output.requiresApproval, true);
        assert.equal(output.decision, 'REQUIRE_APPROVAL');
    });

    it('returns allow for unknown enforcement point', function () {
        const dir = makeTempProject({
            policies: {
                pre_execution: [
                    {
                        name: 'agent-limit',
                        rule: 'active_agents <= 3',
                        action: 'deny',
                    },
                ],
            },
        });
        tmpDirs.push(dir);
        const result = runCheck('nonexistent_point', '{}', dir);
        assert.equal(result.status, 0, 'Expected exit code 0 for unknown enforcement point');
        const output = JSON.parse(result.stdout);
        assert.equal(output.allowed, true);
    });

    it('exits 1 with invalid context JSON', function () {
        const dir = makeTempProject();
        tmpDirs.push(dir);
        const result = runCheck('pre_execution', '{bad json!!!', dir);
        assert.equal(result.status, 1, 'Expected exit code 1 for invalid JSON');
        assert.ok(result.stderr.includes('Invalid context JSON'), 'Expected stderr to mention invalid JSON');
    });

    it('exits 1 when no enforcement point provided', function () {
        const dir = makeTempProject();
        tmpDirs.push(dir);
        const result = runCheck(undefined, undefined, dir);
        assert.equal(result.status, 1, 'Expected exit code 1 for missing enforcement point');
        assert.ok(result.stderr.includes('Usage:'), 'Expected usage message on stderr');
    });
});

describe('check.js autonomy exit codes', function () {
    it('propose exits 1, actions require_approval exits 2, execute exits 0 for pr', function () {
        const cases = [
            [{ autonomy: 'propose' }, 1],
            [{ autonomy: 'execute', actions: { pr: 'require_approval' } }, 2],
            [{ autonomy: 'execute' }, 0],
        ];
        for (const [doc, code] of cases) {
            const dir = makeTempProject(doc);
            try {
                const r = runCheck('pre_deployment', '{"action":"pr"}', dir);
                assert.strictEqual(r.status, code);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    });
});
