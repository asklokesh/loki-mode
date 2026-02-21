'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker, STATE } = require('../../src/protocols/mcp-circuit-breaker');

describe('CircuitBreaker', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 100 });
  });

  afterEach(() => {
    breaker.destroy();
  });

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      assert.equal(breaker.state, STATE.CLOSED);
    });

    it('starts with zero failures', () => {
      assert.equal(breaker.failureCount, 0);
    });
  });

  describe('state transitions', () => {
    it('stays CLOSED on success', async () => {
      await breaker.execute(() => Promise.resolve('ok'));
      assert.equal(breaker.state, STATE.CLOSED);
      assert.equal(breaker.failureCount, 0);
    });

    it('counts failures but stays CLOSED below threshold', async () => {
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }
      assert.equal(breaker.state, STATE.CLOSED);
      assert.equal(breaker.failureCount, 2);
    });

    it('transitions to OPEN after failureThreshold consecutive failures', async () => {
      const events = [];
      breaker.on('open', () => events.push('open'));

      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }

      assert.equal(breaker.state, STATE.OPEN);
      assert.equal(breaker.failureCount, 3);
      assert.deepEqual(events, ['open']);
    });

    it('rejects calls immediately when OPEN', async () => {
      // Open the breaker
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }
      assert.equal(breaker.state, STATE.OPEN);

      const events = [];
      breaker.on('rejected', () => events.push('rejected'));

      await assert.rejects(
        () => breaker.execute(() => Promise.resolve('should not run')),
        { code: 'CIRCUIT_OPEN' }
      );
      assert.deepEqual(events, ['rejected']);
    });

    it('transitions OPEN -> HALF_OPEN after resetTimeout', async () => {
      // Open the breaker
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }
      assert.equal(breaker.state, STATE.OPEN);

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(breaker.state, STATE.HALF_OPEN);
    });

    it('transitions HALF_OPEN -> CLOSED on success', async () => {
      const events = [];
      breaker.on('closed', () => events.push('closed'));

      // Open the breaker
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }

      // Wait for half-open
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(breaker.state, STATE.HALF_OPEN);

      // Success in half-open transitions to closed
      const result = await breaker.execute(() => Promise.resolve('recovered'));
      assert.equal(result, 'recovered');
      assert.equal(breaker.state, STATE.CLOSED);
      assert.equal(breaker.failureCount, 0);
      assert.ok(events.includes('closed'));
    });

    it('transitions HALF_OPEN -> OPEN on failure', async () => {
      // Open the breaker
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }

      // Wait for half-open
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(breaker.state, STATE.HALF_OPEN);

      // Fail in half-open re-opens
      try {
        await breaker.execute(() => Promise.reject(new Error('still failing')));
      } catch (_) {}

      assert.equal(breaker.state, STATE.OPEN);
    });

    it('resets failure count on success', async () => {
      // 2 failures
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }
      assert.equal(breaker.failureCount, 2);

      // Success resets count
      await breaker.execute(() => Promise.resolve('ok'));
      assert.equal(breaker.failureCount, 0);
      assert.equal(breaker.state, STATE.CLOSED);
    });
  });

  describe('manual recording', () => {
    it('recordSuccess resets failures', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      assert.equal(breaker.failureCount, 2);
      breaker.recordSuccess();
      assert.equal(breaker.failureCount, 0);
    });

    it('recordFailure increments and eventually opens', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      assert.equal(breaker.state, STATE.OPEN);
    });
  });

  describe('reset()', () => {
    it('resets to CLOSED from OPEN', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }
      assert.equal(breaker.state, STATE.OPEN);

      breaker.reset();
      assert.equal(breaker.state, STATE.CLOSED);
      assert.equal(breaker.failureCount, 0);
    });
  });

  describe('events', () => {
    it('emits open, half-open, and closed events', async () => {
      const events = [];
      breaker.on('open', () => events.push('open'));
      breaker.on('half-open', () => events.push('half-open'));
      breaker.on('closed', () => events.push('closed'));

      // Cause OPEN
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }

      // Wait for HALF_OPEN
      await new Promise((r) => setTimeout(r, 150));

      // Cause CLOSED
      await breaker.execute(() => Promise.resolve('ok'));

      assert.deepEqual(events, ['open', 'half-open', 'closed']);
    });

    it('emits rejected when OPEN', async () => {
      const events = [];
      breaker.on('rejected', () => events.push('rejected'));

      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch (_) {}
      }

      try {
        await breaker.execute(() => Promise.resolve('nope'));
      } catch (_) {}

      assert.deepEqual(events, ['rejected']);
    });
  });

  describe('destroy()', () => {
    it('cleans up timers and listeners', () => {
      breaker.on('open', () => {});
      breaker.destroy();
      assert.equal(breaker.listenerCount('open'), 0);
    });
  });
});
