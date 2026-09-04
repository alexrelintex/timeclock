/**
 * Time-clock embed loader (v1). The ONLY file the host CRM references:
 *   <script src="https://cdn.YOURAPP.com/embed/v1/loader.js"
 *           data-tenant="acme" async></script>
 *
 * Serve with Cache-Control: max-age=300. It injects an iframe on the widget
 * origin (full isolation) and brokers identity via postMessage with a strict
 * origin allowlist. The host page must supply a short-lived signed identity
 * JWT minted by the HOST BACKEND (never a raw user id) via:
 *   window.TimeClock.setIdentityToken(jwt)
 * CSP the host must allow:
 *   script-src  https://cdn.YOURAPP.com
 *   frame-src   https://widget.YOURAPP.com
 */
(function () {
  'use strict';
  var WIDGET_ORIGIN = 'https://widget.YOURAPP.com'; // build-time substitution
  var PROTOCOL_VERSION = 1;

  var script = document.currentScript;
  var tenant = (script && script.getAttribute('data-tenant')) || '';
  if (!tenant) return console.error('[timeclock] missing data-tenant');

  // Floating launcher button (Shadow DOM for style isolation; punch UI itself
  // lives in the iframe — the stronger boundary — never inline).
  var hostEl = document.createElement('div');
  hostEl.id = 'timeclock-root';
  var shadow = hostEl.attachShadow({ mode: 'closed' });

  var frame = document.createElement('iframe');
  frame.src =
    WIDGET_ORIGIN + '/embed?tenant=' + encodeURIComponent(tenant) + '&v=' + PROTOCOL_VERSION;
  frame.title = 'Time clock';
  frame.allow = '';
  frame.style.cssText =
    'position:fixed;bottom:16px;right:16px;width:72px;height:72px;border:0;' +
    'border-radius:36px;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;' +
    'transition:width .18s ease,height .18s ease,border-radius .18s ease;';
  shadow.appendChild(frame);
  document.body.appendChild(hostEl);

  var pendingToken = null;
  var ready = false;

  function send(type, payload) {
    frame.contentWindow &&
      frame.contentWindow.postMessage(
        { source: 'timeclock-host', version: PROTOCOL_VERSION, type: type, payload: payload },
        WIDGET_ORIGIN // never '*'
      );
  }

  window.addEventListener('message', function (ev) {
    if (ev.origin !== WIDGET_ORIGIN) return; // strict allowlist
    var msg = ev.data || {};
    if (msg.source !== 'timeclock-widget') return;

    switch (msg.type) {
      case 'ready':
        ready = true;
        if (pendingToken) {
          send('identity', { token: pendingToken });
          pendingToken = null;
        }
        break;
      case 'resize': // expand/collapse between launcher and panel
        var p = msg.payload || {};
        frame.style.width = (p.width || 72) + 'px';
        frame.style.height = (p.height || 72) + 'px';
        frame.style.borderRadius = p.expanded ? '14px' : '36px';
        break;
      case 'token-expired':
        // Host should mint a fresh identity JWT and call setIdentityToken again.
        document.dispatchEvent(new CustomEvent('timeclock:token-expired'));
        break;
    }
  });

  window.TimeClock = {
    /** jwt: short-lived (<=5 min) signed assertion from the HOST BACKEND. */
    setIdentityToken: function (jwt) {
      if (ready) send('identity', { token: jwt });
      else pendingToken = jwt;
    },
  };
})();
