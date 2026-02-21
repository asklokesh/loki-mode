'use strict';

const { EventEmitter } = require('events');

/**
 * Circuit Breaker for MCP server connections.
 *
 * States:
 *   CLOSED    - Normal operation, requests pass through
 *   OPEN      - Failures exceeded threshold, requests are rejected immediately
 *   HALF_OPEN - Testing recovery, one request allowed through
 *
 * Transitions:
 *   CLOSED -> OPEN:      After failureThreshold consecutive failures
 *   OPEN -> HALF_OPEN:   After resetTimeout elapses
 *   HALF_OPEN -> CLOSED: On first success
 *   HALF_OPEN -> OPEN:   On first failure
 */

const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.failureThreshold=3] - Consecutive failures before opening
   * @param {number} [options.resetTimeout=30000] - ms before attempting recovery
   */
  constructor(options) {
    super();
    const opts = options || {};
    this._failureThreshold = opts.failureThreshold || 3;
    this._resetTimeout = opts.resetTimeout || 30000;

    this._state = STATE.CLOSED;
    this._failureCount = 0;
    this._openedAt = 0;
    this._resetTimer = null;
  }

  /** Current state string. */
  get state() {
    return this._state;
  }

  /** Number of consecutive failures recorded. */
  get failureCount() {
    return this._failureCount;
  }

  /**
   * Execute a function through the circuit breaker.
   * @param {function} fn - Async function to execute
   * @returns {Promise<*>} Result of fn
   */
  async execute(fn) {
    if (this._state === STATE.OPEN) {
      // Check if enough time has passed to try half-open
      if (Date.now() - this._openedAt >= this._resetTimeout) {
        this._transitionTo(STATE.HALF_OPEN);
      } else {
        this.emit('rejected');
        const err = new Error('Circuit breaker is OPEN');
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  /**
   * Record a success manually (useful when not using execute()).
   */
  recordSuccess() {
    this._onSuccess();
  }

  /**
   * Record a failure manually (useful when not using execute()).
   */
  recordFailure() {
    this._onFailure();
  }

  /**
   * Reset to CLOSED state.
   */
  reset() {
    this._failureCount = 0;
    if (this._state !== STATE.CLOSED) {
      this._transitionTo(STATE.CLOSED);
    }
  }

  /**
   * Clean up timers.
   */
  destroy() {
    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
    this.removeAllListeners();
  }

  _onSuccess() {
    this._failureCount = 0;
    if (this._state === STATE.HALF_OPEN) {
      this._transitionTo(STATE.CLOSED);
    }
  }

  _onFailure() {
    this._failureCount++;
    if (this._state === STATE.HALF_OPEN) {
      // Immediately re-open on any failure in half-open
      this._transitionTo(STATE.OPEN);
      return;
    }
    if (this._state === STATE.CLOSED && this._failureCount >= this._failureThreshold) {
      this._transitionTo(STATE.OPEN);
    }
  }

  _transitionTo(newState) {
    const oldState = this._state;
    this._state = newState;

    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }

    if (newState === STATE.OPEN) {
      this._openedAt = Date.now();
      // Schedule automatic half-open check
      this._resetTimer = setTimeout(() => {
        if (this._state === STATE.OPEN) {
          this._transitionTo(STATE.HALF_OPEN);
        }
      }, this._resetTimeout);
      // Do not block process exit
      if (this._resetTimer.unref) {
        this._resetTimer.unref();
      }
    }

    if (oldState !== newState) {
      this.emit(newState.toLowerCase().replace('_', '-'));
    }
  }
}

module.exports = { CircuitBreaker, STATE };
