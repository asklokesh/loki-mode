/**
 * Control Plane availability helper tests (pure, no vscode host needed).
 */

/// <reference types="mocha" />

import * as assert from 'assert';
import {
    isNotAvailableStatus,
    createNotAvailableError,
    isNotAvailableError,
    NOT_AVAILABLE_TEXT,
    NOT_AVAILABLE_CODE,
} from '../../src/api/availability';

describe('Control Plane availability', () => {
    it('treats 501 and 410 as not available', () => {
        assert.strictEqual(isNotAvailableStatus(501), true);
        assert.strictEqual(isNotAvailableStatus(410), true);
    });

    it('does not treat other statuses as not available', () => {
        for (const s of [200, 401, 404, 500, 502, undefined]) {
            assert.strictEqual(isNotAvailableStatus(s), false);
        }
    });

    it('builds an honest error naming the feature', () => {
        const e = createNotAvailableError('POST /api/control/stop', 501);
        assert.ok(e.message.includes(NOT_AVAILABLE_TEXT));
        assert.ok(e.message.includes('/api/control/stop'));
        assert.strictEqual(e.code, NOT_AVAILABLE_CODE);
        assert.strictEqual(e.statusCode, 501);
        assert.strictEqual(isNotAvailableError(e), true);
    });

    it('does not misclassify ordinary errors', () => {
        assert.strictEqual(isNotAvailableError(new Error('HTTP 500')), false);
        assert.strictEqual(isNotAvailableError('x'), false);
    });
});
