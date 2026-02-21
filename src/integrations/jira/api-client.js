'use strict';

var https = require('https');
var http = require('http');
var url = require('url');

/**
 * Jira API Error.
 */
class JiraApiError extends Error {
  constructor(status, message, response) {
    super('Jira API ' + status + ': ' + message);
    this.name = 'JiraApiError';
    this.status = status;
    this.response = response;
  }
}

/**
 * Jira Cloud REST API v3 client.
 */
class JiraApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - Jira Cloud base URL (e.g., https://company.atlassian.net)
   * @param {string} opts.email - Jira user email
   * @param {string} opts.apiToken - Jira API token
   * @param {number} [opts.rateDelayMs] - Delay between requests (default 100)
   */
  constructor(opts) {
    if (!opts || !opts.baseUrl || !opts.email || !opts.apiToken) {
      throw new Error('JiraApiClient requires baseUrl, email, and apiToken');
    }
    this._baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this._authHeader = 'Basic ' + Buffer.from(opts.email + ':' + opts.apiToken).toString('base64');
    this._rateDelayMs = opts.rateDelayMs || 100;
    this._lastRequestTime = 0;
  }

  getIssue(issueKey) {
    return this._request('GET', '/rest/api/3/issue/' + encodeURIComponent(issueKey));
  }

  searchIssues(jql, fields) {
    var body = { jql: jql, maxResults: 100 };
    if (fields) body.fields = fields;
    return this._request('POST', '/rest/api/3/search', body);
  }

  getEpicChildren(epicKey) {
    var key = String(epicKey);
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) {
      return Promise.reject(new Error('Invalid epic key format: ' + key));
    }
    return this.searchIssues('"Epic Link" = "' + key + '" ORDER BY rank ASC');
  }

  createIssue(fields) {
    return this._request('POST', '/rest/api/3/issue', { fields: fields });
  }

  updateIssue(issueKey, fields) {
    return this._request('PUT', '/rest/api/3/issue/' + encodeURIComponent(issueKey), { fields: fields });
  }

  addComment(issueKey, body) {
    var adf = typeof body === 'string' ? {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    } : body;
    return this._request('POST', '/rest/api/3/issue/' + encodeURIComponent(issueKey) + '/comment', { body: adf });
  }

  getTransitions(issueKey) {
    return this._request('GET', '/rest/api/3/issue/' + encodeURIComponent(issueKey) + '/transitions');
  }

  transitionIssue(issueKey, transitionId) {
    return this._request('POST', '/rest/api/3/issue/' + encodeURIComponent(issueKey) + '/transitions', {
      transition: { id: String(transitionId) },
    });
  }

  addRemoteLink(issueKey, linkUrl, title) {
    return this._request('POST', '/rest/api/3/issue/' + encodeURIComponent(issueKey) + '/remotelink', {
      object: { url: linkUrl, title: title || linkUrl },
    });
  }

  getAuthHeader() { return this._authHeader; }

  _request(method, path, body) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var now = Date.now();
      var delay = Math.max(0, self._rateDelayMs - (now - self._lastRequestTime));

      setTimeout(function () {
        self._lastRequestTime = Date.now();
        var reqUrl = self._baseUrl + path;
        var parsed = new url.URL(reqUrl);
        var mod = parsed.protocol === 'https:' ? https : http;
        var headers = {
          'Authorization': self._authHeader,
          'Accept': 'application/json',
        };
        var bodyStr = null;
        if (body) {
          bodyStr = JSON.stringify(body);
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        var opts = {
          method: method,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          headers: headers,
        };
        var MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB
        var req = mod.request(opts, function (res) {
          var chunks = [];
          var totalSize = 0;
          res.on('data', function (c) {
            totalSize += c.length;
            if (totalSize > MAX_RESPONSE_SIZE) {
              res.destroy(new Error('Response size exceeds 10 MB limit'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', function () {
            var raw = Buffer.concat(chunks).toString();
            if (res.statusCode >= 400) {
              reject(new JiraApiError(res.statusCode, raw.slice(0, 300), raw));
              return;
            }
            if (res.statusCode === 204 || !raw) { resolve(null); return; }
            try { resolve(JSON.parse(raw)); }
            catch (_) { resolve(raw); }
          });
        });
        req.on('error', reject);
        req.setTimeout(30000, function () { req.destroy(new Error('Request timeout')); });
        if (bodyStr) req.write(bodyStr);
        req.end();
      }, delay);
    });
  }
}

module.exports = { JiraApiClient, JiraApiError };
