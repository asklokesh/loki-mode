/**
 * Loki Mode Poll Registry
 *
 * A single, central scheduler for dashboard component polling. Components
 * register their data-load intent (a load function + interval + which section
 * the component lives in) and the registry decides -- in ONE place -- whether
 * each poll is allowed to run this tick.
 *
 * A poll runs only when BOTH are true:
 *   1. The document is visible (document.hidden === false), AND
 *   2. The registration's section is the active section-page (or the
 *      registration opted out of section gating via sectionId === null).
 *
 * This replaces the per-component pattern of
 *   setInterval(() => this._loadData(), N)
 * which fired even when the tab was hidden or the component's section-page was
 * not the active view, flooding the network tab. With the registry, a hidden
 * tab does zero polling and only the active section polls.
 *
 * The active section is derived from the SPA's existing section switching in
 * build-standalone.js, which toggles `.active` on `.section-page` elements
 * (id `page-<sectionId>`) and dispatches a `loki:section-change` event. The
 * registry also installs a defensive MutationObserver + a localStorage
 * fallback so it stays correct even if the event is missed (e.g. a component
 * mounted before the SPA wired up its listeners).
 *
 * Design notes:
 *  - Each registration keeps its own setInterval cadence (so a 60s panel and a
 *    3s panel keep their own rhythm), but the registry gates whether the tick
 *    actually calls loadFn. A gated-out tick does NOT fetch.
 *  - When a registration transitions from "not allowed" to "allowed" (the user
 *    switches to its section, or returns to the tab), the registry fires an
 *    immediate load so the freshly-shown view is up to date without waiting a
 *    full interval. Transitions to "not allowed" simply stop firing.
 *  - This module is environment-safe: in a non-DOM context (Node without
 *    document) it degrades to "always allowed" so non-browser callers are not
 *    silently starved.
 */

/**
 * Strip the `page-` prefix that build-standalone.js uses for section-page ids
 * to recover the bare section id (`page-overview` -> `overview`).
 * @param {string|null|undefined} pageId
 * @returns {string|null}
 */
function sectionIdFromPageId(pageId) {
  if (!pageId || typeof pageId !== 'string') return null;
  return pageId.startsWith('page-') ? pageId.slice('page-'.length) : pageId;
}

/**
 * Read the currently active section directly from the DOM. Used as the source
 * of truth on init and as a defensive re-sync; the event path keeps it fresh
 * during normal navigation.
 * @returns {string|null}
 */
function readActiveSectionFromDom() {
  if (typeof document === 'undefined') return null;
  const active = document.querySelector('.section-page.active');
  if (active && active.id) return sectionIdFromPageId(active.id);
  // Fallback: the SPA persists the last-active section in localStorage.
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('loki-active-section');
      if (stored) return stored;
    }
  } catch (e) {
    /* localStorage may be unavailable (sandboxed iframe); ignore */
  }
  return null;
}

/**
 * PollRegistry -- the single gating scheduler. A module-level singleton is the
 * intended use (see getPollRegistry); the class is exported for tests that
 * want an isolated instance.
 */
export class PollRegistry {
  constructor() {
    /** @type {Map<string, object>} id -> registration record */
    this._regs = new Map();
    this._seq = 0;
    this._activeSection = readActiveSectionFromDom();
    this._hidden = (typeof document !== 'undefined') ? Boolean(document.hidden) : false;
    this._listenersInstalled = false;
    this._sectionChangeHandler = null;
    this._visibilityHandler = null;
    this._mutationObserver = null;
  }

  /**
   * Whether the registry can currently observe a real DOM. In a non-DOM
   * environment, gating is disabled (everything is "allowed") so non-browser
   * callers are not starved.
   * @returns {boolean}
   */
  get _hasDom() {
    return typeof document !== 'undefined';
  }

  /**
   * Install the single set of global listeners that drive gating. Idempotent.
   * Called lazily on first registration so importing the module has no side
   * effects.
   */
  _ensureListeners() {
    if (this._listenersInstalled || !this._hasDom) return;

    // Primary signal: the SPA dispatches this when switchSection() runs.
    this._sectionChangeHandler = (e) => {
      const next = (e && e.detail && e.detail.section)
        ? e.detail.section
        : readActiveSectionFromDom();
      this._setActiveSection(next);
    };
    document.addEventListener('loki:section-change', this._sectionChangeHandler);

    // Tab visibility: a hidden tab polls nothing; returning re-syncs + fires.
    this._visibilityHandler = () => {
      const hidden = Boolean(document.hidden);
      if (hidden === this._hidden) return;
      this._hidden = hidden;
      // Re-read the active section on return in case it changed while hidden
      // (e.g. via a shared #section= link in another tab is not possible, but
      // be defensive).
      if (!hidden) this._activeSection = readActiveSectionFromDom();
      this._reevaluateAll();
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);

    // Defensive fallback: if the section-change event is ever missed (a
    // component mounted before the SPA wired its nav, or a code path that
    // toggles .active without dispatching), observe class changes on the
    // section-pages container and re-derive.
    try {
      const root = document.getElementById('main-content') || document.body;
      if (root && typeof MutationObserver !== 'undefined') {
        this._mutationObserver = new MutationObserver(() => {
          const fromDom = readActiveSectionFromDom();
          if (fromDom && fromDom !== this._activeSection) {
            this._setActiveSection(fromDom);
          }
        });
        this._mutationObserver.observe(root, {
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        });
      }
    } catch (e) {
      /* MutationObserver unavailable: event + visibility paths still gate */
    }

    this._listenersInstalled = true;
  }

  /**
   * Update the active section and re-evaluate every registration. A no-op if
   * the section is unchanged.
   * @param {string|null} section
   */
  _setActiveSection(section) {
    if (section === this._activeSection) return;
    this._activeSection = section;
    this._reevaluateAll();
  }

  /**
   * Resolve the section a registration belongs to. An explicit sectionId wins;
   * sectionId === null explicitly opts out of section gating; otherwise derive
   * from the bound element's nearest .section-page ancestor (re-derived each
   * call so a moved element stays correct).
   * @param {object} reg
   * @returns {string|null|undefined} undefined means "ungated" (no section)
   */
  _resolveSection(reg) {
    if (Object.prototype.hasOwnProperty.call(reg, 'sectionId')) {
      // Explicit null means "do not gate on section".
      return reg.sectionId === null ? undefined : reg.sectionId;
    }
    if (reg.element && typeof reg.element.closest === 'function') {
      const page = reg.element.closest('.section-page');
      const derived = sectionIdFromPageId(page && page.id);
      return derived === null ? undefined : derived;
    }
    return undefined;
  }

  /**
   * Whether a registration is allowed to fire right now: visible tab AND its
   * section is active (ungated registrations only require visibility).
   * @param {object} reg
   * @returns {boolean}
   */
  _isAllowed(reg) {
    if (!this._hasDom) return true; // non-DOM: never starve callers
    if (this._hidden) return false;
    const section = this._resolveSection(reg);
    if (section === undefined) return true; // ungated: visibility only
    return section === this._activeSection;
  }

  /**
   * Re-evaluate every registration's gating. Registrations that just became
   * allowed fire an immediate load (catch-up); those that became disallowed
   * simply stop firing on the next tick. The per-registration interval timer
   * keeps running regardless -- it is the tick callback that gates -- so the
   * cadence is preserved across activate/deactivate cycles without churning
   * timers.
   */
  _reevaluateAll() {
    for (const reg of this._regs.values()) {
      const allowedNow = this._isAllowed(reg);
      if (allowedNow && !reg._wasAllowed) {
        // Became active+visible: refresh immediately so the shown view is
        // current without waiting a full interval.
        reg._wasAllowed = true;
        this._safeRun(reg);
      } else {
        reg._wasAllowed = allowedNow;
      }
    }
  }

  /**
   * Invoke a registration's loadFn, swallowing errors so one panel's failure
   * never breaks the registry or other panels. loadFn may be sync or async.
   * @param {object} reg
   */
  _safeRun(reg) {
    try {
      const r = reg.loadFn();
      if (r && typeof r.then === 'function') {
        r.catch(() => { /* component owns its own error rendering */ });
      }
    } catch (e) {
      /* component owns its own error rendering */
    }
  }

  /**
   * Register a polling intent.
   *
   * @param {object} opts
   * @param {Function} opts.loadFn - the data-load function to call each
   *   allowed tick (sync or async). Required.
   * @param {number} opts.intervalMs - cadence in ms. Required, > 0.
   * @param {string} [opts.id] - stable id; auto-generated if omitted.
   * @param {string|null} [opts.sectionId] - the section this poll belongs to.
   *   Omit to auto-derive from `element`. Pass null to opt OUT of section
   *   gating (still visibility-gated).
   * @param {Element} [opts.element] - the component element, used to
   *   auto-derive sectionId from its nearest .section-page ancestor.
   * @param {boolean} [opts.immediate=true] - run loadFn once now if currently
   *   allowed.
   * @returns {{ id: string, stop: Function, isActive: Function }} handle
   */
  register(opts = {}) {
    const { loadFn, intervalMs } = opts;
    if (typeof loadFn !== 'function') {
      throw new Error('registerPoll: loadFn must be a function');
    }
    if (typeof intervalMs !== 'number' || !(intervalMs > 0)) {
      throw new Error('registerPoll: intervalMs must be a positive number');
    }

    this._ensureListeners();

    const id = opts.id || `poll-${++this._seq}`;
    // Replacing an existing id cleanly stops the prior timer.
    if (this._regs.has(id)) {
      this._stopReg(this._regs.get(id));
    }

    const reg = {
      id,
      loadFn,
      intervalMs,
      element: opts.element || null,
      _timer: null,
      _wasAllowed: false,
    };
    if (Object.prototype.hasOwnProperty.call(opts, 'sectionId')) {
      reg.sectionId = opts.sectionId;
    }

    reg._wasAllowed = this._isAllowed(reg);

    reg._timer = setInterval(() => {
      if (this._isAllowed(reg)) {
        reg._wasAllowed = true;
        this._safeRun(reg);
      } else {
        reg._wasAllowed = false;
      }
    }, intervalMs);

    this._regs.set(id, reg);

    // Optional immediate first load (default on) when currently allowed, so a
    // visible active panel shows data right away.
    const immediate = opts.immediate !== false;
    if (immediate && reg._wasAllowed) {
      this._safeRun(reg);
    }

    return {
      id,
      stop: () => this.unregister(id),
      isActive: () => this._isAllowed(reg),
    };
  }

  /**
   * Stop a registration's timer (internal).
   * @param {object} reg
   */
  _stopReg(reg) {
    if (reg && reg._timer) {
      clearInterval(reg._timer);
      reg._timer = null;
    }
  }

  /**
   * Unregister a poll by id and stop its timer.
   * @param {string} id
   * @returns {boolean} whether a registration was removed
   */
  unregister(id) {
    const reg = this._regs.get(id);
    if (!reg) return false;
    this._stopReg(reg);
    this._regs.delete(id);
    return true;
  }

  /**
   * Current active section as the registry sees it (for tests/diagnostics).
   * @returns {string|null}
   */
  get activeSection() {
    return this._activeSection;
  }

  /**
   * Number of live registrations (for tests/diagnostics).
   * @returns {number}
   */
  get size() {
    return this._regs.size;
  }

  /**
   * Tear down all registrations and global listeners. Mainly for tests.
   */
  destroy() {
    for (const reg of this._regs.values()) this._stopReg(reg);
    this._regs.clear();
    if (this._hasDom) {
      if (this._sectionChangeHandler) {
        document.removeEventListener('loki:section-change', this._sectionChangeHandler);
        this._sectionChangeHandler = null;
      }
      if (this._visibilityHandler) {
        document.removeEventListener('visibilitychange', this._visibilityHandler);
        this._visibilityHandler = null;
      }
      if (this._mutationObserver) {
        this._mutationObserver.disconnect();
        this._mutationObserver = null;
      }
    }
    this._listenersInstalled = false;
  }
}

// Module-level singleton: one registry per page so gating is enforced in one
// place across every component.
let _singleton = null;

/**
 * Get the shared poll registry singleton.
 * @returns {PollRegistry}
 */
export function getPollRegistry() {
  if (!_singleton) _singleton = new PollRegistry();
  return _singleton;
}

/**
 * Register a polling intent on the shared registry. This is the API components
 * use in place of `setInterval(() => this._loadData(), N)`.
 *
 * Typical component usage (in connectedCallback):
 *   this._poll = registerPoll({
 *     loadFn: () => this._loadData(),
 *     intervalMs: 3000,
 *     element: this,            // auto-derives its section from the DOM
 *   });
 * and in disconnectedCallback:
 *   if (this._poll) { this._poll.stop(); this._poll = null; }
 *
 * @param {object} opts - see PollRegistry#register
 * @returns {{ id: string, stop: Function, isActive: Function }}
 */
export function registerPoll(opts) {
  return getPollRegistry().register(opts);
}

/**
 * Reset the singleton (tests only).
 */
export function _resetPollRegistry() {
  if (_singleton) _singleton.destroy();
  _singleton = null;
}

export default getPollRegistry;
