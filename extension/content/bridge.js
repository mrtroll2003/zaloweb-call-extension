// Zalo Web Call - bridge (isolated content-script world).
// Relays between the page hook (MAIN world, via DOM events carrying JSON
// strings) and the extension service worker (via a long-lived port), and
// answers the popup's status questions.
(() => {
  'use strict';
  const EVT_TO_EXT = 'zalo-web-call:to-ext';
  const EVT_TO_PAGE = 'zalo-web-call:to-page';

  let port = null;
  let dead = false;
  let lastStatus = null;

  function toPage(payload) {
    document.dispatchEvent(new CustomEvent(EVT_TO_PAGE, { detail: JSON.stringify(payload) }));
  }

  function connect() {
    if (port || dead) return port;
    try {
      port = chrome.runtime.connect({ name: 'zalo-web-call' });
    } catch (e) {
      // "Extension context invalidated": the extension was reloaded or removed.
      dead = true;
      toPage({ kind: 'bridge-down', error: String((e && e.message) || e) });
      return null;
    }
    port.onMessage.addListener((m) => toPage(m));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      toPage({ kind: 'bridge-reset' });
    });
    return port;
  }

  document.addEventListener(EVT_TO_EXT, (e) => {
    let payload;
    try {
      payload = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (!payload) return;
    if (payload.kind === 'status') {
      lastStatus = payload.status;
      return;
    }
    const p = connect();
    if (!p) return;
    try {
      p.postMessage(payload);
    } catch (err) {
      port = null;
      const again = connect();
      if (again) {
        try {
          again.postMessage(payload);
        } catch (err2) {
          /* give up on this message */
        }
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'zwc-status') {
      sendResponse(lastStatus || { notLoaded: true });
    }
  });
})();
