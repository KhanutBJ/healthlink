/**
 * inject.js: Runs in the PAGE context (not content script context).
 * Intercepts XHR and fetch calls to capture API responses
 * that contain registration data and document URLs.
 */
(() => {
  'use strict';

  const INTERCEPT_PATTERNS = [
    /\/api\/.*health.?unit/i,
    /\/api\/.*register/i,
    /\/api\/.*document/i,
    /\/api\/.*file/i,
    /\/api\/.*request/i,
    /\/admin\/health_unit/i,
  ];

  function shouldIntercept(url) {
    return INTERCEPT_PATTERNS.some((p) => p.test(url));
  }

  function postToContentScript(type, data) {
    window.postMessage(
      {
        source: 'HEALTHLINK_INTERCEPTOR',
        type,
        data,
        timestamp: Date.now(),
      },
      '*',
    );
  }

  // --- Intercept fetch() ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request?.url || '';

    const response = await originalFetch.apply(this, args);

    if (shouldIntercept(url)) {
      try {
        const clone = response.clone();
        const contentType = clone.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
          const json = await clone.json();
          postToContentScript('API_RESPONSE', {
            url,
            method: args[1]?.method || 'GET',
            status: clone.status,
            body: json,
          });
        }
      } catch (e) {
        // Silently fail: don't break the page
      }
    }

    return response;
  };

  // --- Intercept XMLHttpRequest ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._hlUrl = url;
    this._hlMethod = method;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._hlUrl && shouldIntercept(this._hlUrl)) {
      this.addEventListener('load', function () {
        try {
          const contentType = this.getResponseHeader('content-type') || '';
          if (contentType.includes('application/json')) {
            const json = JSON.parse(this.responseText);
            postToContentScript('API_RESPONSE', {
              url: this._hlUrl,
              method: this._hlMethod,
              status: this.status,
              body: json,
            });
          }
        } catch (e) {
          // Silently fail
        }
      });
    }
    return originalSend.apply(this, args);
  };

  // Notify that interceptor is ready
  postToContentScript('INTERCEPTOR_READY', { timestamp: Date.now() });

  console.log('[HealthLink Checker] API interceptor loaded');
})();
