/**
 * @fileoverview Loki Council Transcripts - surfaces per-iteration voting records
 * written under .loki/council/transcripts/ by the council writer added in v7.5.16.
 *
 * Each transcript card shows the iteration number, timestamp, a 200-char
 * task/PRD preview, per-voter verdict badges, a contrarian section when the
 * devil's advocate was triggered, and the final outcome badge.
 *
 * When contrarian_flipped=true the DA voter row receives a red border and an
 * "OVERRIDE" badge to signal that it changed the outcome.
 *
 * Polls GET /api/council/transcripts?limit=10 on connect and every 30s.
 *
 * @example
 * <loki-council-transcripts api-url="http://localhost:57374"></loki-council-transcripts>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

export class LokiCouncilTranscripts extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._transcripts = [];
    this._loading = false;
    this._error = null;
    this._api = null;
    this._pollInterval = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._load();
    this._pollInterval = setInterval(() => this._load(), 30000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._load();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl =
      this.getAttribute('api-url') ||
      (typeof window !== 'undefined' ? window.location.origin : '');
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _load() {
    this._loading = true;
    this._error = null;
    try {
      const data = await this._api.get('/api/council/transcripts?limit=10');
      this._transcripts = Array.isArray(data && data.transcripts)
        ? data.transcripts
        : [];
    } catch (err) {
      this._error = (err && err.message) ? err.message : String(err);
      this._transcripts = [];
    } finally {
      this._loading = false;
      this.render();
    }
  }

  _escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _formatTimestamp(iso) {
    if (!iso) return '--';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  _truncate(str, max) {
    if (!str) return '';
    const s = String(str);
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  _verdictBadgeHtml(verdict) {
    const v = String(verdict || '').toUpperCase();
    if (v === 'APPROVE') {
      return '<span class="ct-badge ct-badge-approve">APPROVE</span>';
    }
    if (v === 'REJECT') {
      return '<span class="ct-badge ct-badge-reject">REJECT</span>';
    }
    if (v === 'CANNOT_VALIDATE') {
      return '<span class="ct-badge ct-badge-cannot">CANNOT_VALIDATE</span>';
    }
    return '<span class="ct-badge ct-badge-unknown">' + this._escapeHtml(v || 'UNKNOWN') + '</span>';
  }

  _outcomeBadgeHtml(outcome) {
    const o = String(outcome || '').toUpperCase();
    if (o === 'APPROVED') {
      return '<span class="ct-badge ct-badge-approve">APPROVED</span>';
    }
    if (o === 'REJECTED') {
      return '<span class="ct-badge ct-badge-reject">REJECTED</span>';
    }
    if (o === 'BLOCKED_BY_GATE') {
      return '<span class="ct-badge ct-badge-blocked">BLOCKED BY GATE</span>';
    }
    return '<span class="ct-badge ct-badge-unknown">' + this._escapeHtml(o || 'UNKNOWN') + '</span>';
  }

  _voterRowHtml(voter, contrarian_flipped) {
    const isContrarian = voter.is_contrarian === true;
    const isFlipped = isContrarian && contrarian_flipped === true;

    let rowClass = 'ct-voter-row';
    if (isContrarian) rowClass += ' ct-voter-contrarian';
    if (isFlipped) rowClass += ' ct-voter-flipped';

    const name = this._escapeHtml(voter.name || 'unknown');
    const badge = this._verdictBadgeHtml(voter.verdict);
    const reasoning = this._escapeHtml(this._truncate(voter.reasoning, 300));

    let overrideBadge = '';
    let flipCaption = '';
    if (isFlipped) {
      overrideBadge = '<span class="ct-badge ct-badge-override">OVERRIDE</span>';
      flipCaption = '<div class="ct-flip-caption">Devil\'s Advocate flipped this outcome</div>';
    } else if (isContrarian && voter.triggered) {
      overrideBadge = '<span class="ct-badge ct-badge-da">DEVIL\'S ADVOCATE</span>';
    }

    let challengesHtml = '';
    if (
      isContrarian &&
      Array.isArray(voter.challenges) &&
      voter.challenges.length > 0
    ) {
      const items = voter.challenges
        .map((c) => '<li>' + this._escapeHtml(String(c)) + '</li>')
        .join('');
      challengesHtml =
        '<ul class="ct-challenges">' + items + '</ul>';
    }

    let issuesHtml = '';
    if (Array.isArray(voter.issues) && voter.issues.length > 0) {
      const items = voter.issues
        .map((iss) => {
          const sev = this._escapeHtml(iss.severity || '');
          const desc = this._escapeHtml(iss.description || '');
          return (
            '<li><span class="ct-issue-sev ct-issue-sev-' +
            sev.toLowerCase() +
            '">' + sev + '</span> ' + desc + '</li>'
          );
        })
        .join('');
      issuesHtml = '<ul class="ct-issues">' + items + '</ul>';
    }

    return (
      '<div class="' + rowClass + '">' +
        '<div class="ct-voter-header">' +
          '<span class="ct-voter-name">' + name + '</span>' +
          badge +
          overrideBadge +
        '</div>' +
        (reasoning ? '<div class="ct-voter-reason">' + reasoning + '</div>' : '') +
        challengesHtml +
        issuesHtml +
        flipCaption +
      '</div>'
    );
  }

  _transcriptCardHtml(t) {
    const iterNum = this._escapeHtml(String(t.iteration || '--'));
    const ts = this._escapeHtml(this._formatTimestamp(t.timestamp));
    const preview = this._escapeHtml(this._truncate(t.task_or_prd, 200));
    const outcome = this._outcomeBadgeHtml(t.outcome);

    const voters = Array.isArray(t.voters) ? t.voters : [];
    const regularVoters = voters.filter((v) => !v.is_contrarian);
    const contrarianVoters = voters.filter((v) => v.is_contrarian);

    const voterRows = regularVoters
      .map((v) => this._voterRowHtml(v, false))
      .join('');

    let contrarianSection = '';
    if (t.contrarian_triggered) {
      const daRows = contrarianVoters
        .map((v) => this._voterRowHtml(v, t.contrarian_flipped))
        .join('');
      contrarianSection =
        '<div class="ct-contrarian-section">' +
          '<div class="ct-section-label">Anti-Sycophancy Check</div>' +
          daRows +
        '</div>';
    }

    const approveCount = typeof t.approve_count === 'number' ? t.approve_count : '--';
    const rejectCount = typeof t.reject_count === 'number' ? t.reject_count : '--';
    const threshold = typeof t.threshold === 'number' ? t.threshold : '--';

    return (
      '<div class="ct-card">' +
        '<div class="ct-card-header">' +
          '<div class="ct-card-meta">' +
            '<span class="ct-iter-label">Iteration ' + iterNum + '</span>' +
            '<span class="ct-ts">' + ts + '</span>' +
          '</div>' +
          outcome +
        '</div>' +
        (preview
          ? '<div class="ct-prd-preview">' + preview + '</div>'
          : '') +
        '<div class="ct-tally">Approve: ' + approveCount +
          ' &middot; Reject: ' + rejectCount +
          ' &middot; Threshold: ' + threshold +
        '</div>' +
        '<div class="ct-voters">' + voterRows + '</div>' +
        contrarianSection +
      '</div>'
    );
  }

  render() {
    const root = this.shadowRoot || this;
    if (!root) return;

    const styleBlock = `
      <style>
        :host { display: block; margin-top: 24px; }
        .ct-wrapper {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          color: var(--text-primary, #201515);
        }
        .ct-heading {
          font-family: 'DM Serif Display', Georgia, serif;
          font-size: 1.15rem;
          font-weight: 400;
          color: var(--loki-text-primary, #201515);
          margin: 0 0 12px 0;
        }
        .ct-explain {
          color: var(--text-muted, #939084);
          font-size: 0.875rem;
          margin-bottom: 16px;
        }
        .ct-empty {
          padding: 16px;
          background: var(--bg-card, #ffffff);
          border: 1px dashed var(--border, #ECEAE3);
          border-radius: 6px;
          color: var(--text-muted, #939084);
          font-size: 0.875rem;
        }
        .ct-error {
          padding: 10px 12px;
          background: var(--bg-card, #ffffff);
          border: 1px solid var(--error, #C45B5B);
          border-radius: 6px;
          color: var(--error, #C45B5B);
          font-size: 0.85rem;
        }
        .ct-list { display: flex; flex-direction: column; gap: 16px; }
        .ct-card {
          padding: 16px;
          background: var(--bg-card, #ffffff);
          border: 1px solid var(--border, #ECEAE3);
          border-radius: 8px;
        }
        .ct-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 10px;
        }
        .ct-card-meta {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .ct-iter-label {
          font-weight: 600;
          font-size: 0.95rem;
        }
        .ct-ts {
          font-size: 0.78rem;
          color: var(--text-muted, #939084);
          font-family: 'JetBrains Mono', monospace;
        }
        .ct-prd-preview {
          font-size: 0.82rem;
          color: var(--text-secondary, #36342E);
          background: var(--bg-secondary, #F8F4F0);
          border-radius: 4px;
          padding: 8px 10px;
          margin-bottom: 10px;
          font-style: italic;
        }
        .ct-tally {
          font-size: 0.78rem;
          color: var(--text-muted, #939084);
          margin-bottom: 12px;
        }
        .ct-voters { display: flex; flex-direction: column; gap: 8px; }
        .ct-voter-row {
          padding: 8px 10px;
          border: 1px solid var(--border, #ECEAE3);
          border-radius: 5px;
          background: var(--bg-secondary, #F8F4F0);
        }
        .ct-voter-contrarian {
          border-color: var(--warning, #D4A017);
        }
        .ct-voter-flipped {
          border-color: var(--error, #C45B5B);
          border-width: 2px;
        }
        .ct-voter-header {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 4px;
        }
        .ct-voter-name {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.82rem;
          font-weight: 500;
        }
        .ct-voter-reason {
          font-size: 0.80rem;
          color: var(--text-secondary, #36342E);
          margin-top: 4px;
        }
        .ct-flip-caption {
          font-size: 0.75rem;
          color: var(--error, #C45B5B);
          font-weight: 500;
          margin-top: 4px;
        }
        .ct-contrarian-section {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px dashed var(--border, #ECEAE3);
        }
        .ct-section-label {
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted, #939084);
          margin-bottom: 8px;
        }
        .ct-challenges {
          margin: 6px 0 0 0;
          padding-left: 16px;
          font-size: 0.78rem;
          color: var(--text-secondary, #36342E);
        }
        .ct-challenges li { margin-bottom: 3px; }
        .ct-issues {
          margin: 6px 0 0 0;
          padding-left: 16px;
          font-size: 0.78rem;
          color: var(--text-secondary, #36342E);
        }
        .ct-issues li { margin-bottom: 3px; }
        .ct-issue-sev {
          font-weight: 600;
          font-size: 0.72rem;
          border-radius: 3px;
          padding: 1px 4px;
        }
        .ct-issue-sev-critical { background: #fde8e8; color: #C45B5B; }
        .ct-issue-sev-high     { background: #fdeee8; color: #c4733b; }
        .ct-issue-sev-medium   { background: #fdf6e8; color: #b38a2e; }
        .ct-issue-sev-low      { background: #eaf2e8; color: #4a7c4e; }
        /* Verdict / outcome badges */
        .ct-badge {
          display: inline-block;
          font-size: 0.70rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border-radius: 4px;
          padding: 2px 7px;
          white-space: nowrap;
        }
        .ct-badge-approve  { background: #d4f0dc; color: #2d7d46; }
        .ct-badge-reject   { background: #fde8e8; color: #C45B5B; }
        .ct-badge-cannot   { background: #fdf3d4; color: #8a6c0e; }
        .ct-badge-blocked  { background: #ede8fd; color: #5b3dc4; }
        .ct-badge-override { background: #C45B5B; color: #ffffff; }
        .ct-badge-da       { background: #fdf3d4; color: #8a6c0e; }
        .ct-badge-unknown  { background: var(--bg-secondary, #F8F4F0); color: var(--text-muted, #939084); }
      </style>
    `;

    let body = '';
    if (this._loading && this._transcripts.length === 0) {
      body = '<div class="ct-empty">Loading council transcripts...</div>';
    } else if (this._error) {
      body =
        '<div class="ct-error">Failed to load transcripts: ' +
        this._escapeHtml(this._error) +
        '</div>';
    } else if (!this._transcripts || this._transcripts.length === 0) {
      body =
        '<div class="ct-empty">No council rounds recorded yet -- ' +
        'transcripts appear after the first iteration vote.</div>';
    } else {
      const cards = this._transcripts
        .map((t) => this._transcriptCardHtml(t))
        .join('');
      body = '<div class="ct-list">' + cards + '</div>';
    }

    root.innerHTML =
      styleBlock +
      '<div class="ct-wrapper">' +
        '<h3 class="ct-heading">Council Transcripts</h3>' +
        '<div class="ct-explain">' +
          'Per-iteration voting records from .loki/council/transcripts/. ' +
          'Polls every 30 seconds.' +
        '</div>' +
        body +
      '</div>';
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('loki-council-transcripts')) {
  customElements.define('loki-council-transcripts', LokiCouncilTranscripts);
}
