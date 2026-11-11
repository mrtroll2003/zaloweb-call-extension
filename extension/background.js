// Zalo Web Call - service worker.
// Each chat.zalo.me tab gets its own connection to the native helper
// (com.zalo_web_call.host), which starts Zalo's call engine when needed.
// An open native port also keeps this service worker alive during calls.

const HOST_NAME = 'com.zalo_web_call.host';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'zalo-web-call') return;
  const url = (port.sender && (port.sender.url || (port.sender.tab && port.sender.tab.url))) || '';
  if (!/^https:\/\/chat\.zalo\.me\//.test(url)) {
    port.disconnect();
    return;
  }

  let native = null;

  function openNative() {
    if (native) return native;
    let n;
    try {
      n = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      safePost({ kind: 'host-down', error: String((e && e.message) || e) });
      return null;
    }
    native = n;
    n.onMessage.addListener((msg) => safePost({ kind: 'host', msg }));
    n.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'The call helper exited.';
      if (native === n) native = null;
      safePost({ kind: 'host-down', error });
    });
    return n;
  }

  function safePost(m) {
    try {
      port.postMessage(m);
    } catch (e) {
      /* tab is gone */
    }
  }

  port.onMessage.addListener((m) => {
    if (!m || m.kind !== 'host' || !m.msg) return;
    const n = openNative();
    if (!n) return;
    try {
      n.postMessage(m.msg);
    } catch (e) {
      safePost({ kind: 'host-down', error: String((e && e.message) || e) });
    }
  });

  port.onDisconnect.addListener(() => {
    if (native) {
      try {
        native.disconnect(); // the helper then stops the engine and exits
      } catch (e) {
        /* ignore */
      }
      native = null;
    }
  });
});
