'use strict';

const main = document.getElementById('main');
document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

function check(state, label, detail) {
  return el('li', {}, el('span', { class: `dot ${state}` }), el('span', {}, label, detail ? el('span', { class: 'muted' }, ` — ${detail}`) : ''));
}

function render(s) {
  main.textContent = '';
  if (!s) {
    main.append(
      el('p', {}, 'Open ', el('b', {}, 'chat.zalo.me'), ' in this tab to use calls.'),
      el('p', { class: 'muted' }, 'If Zalo Web is already open here, reload the tab once after installing or updating the extension.'),
    );
    return;
  }
  if (s.notLoaded) {
    main.append(el('p', {}, 'The page hook has not reported yet. Reload the Zalo Web tab.'));
    return;
  }
  const hostOk = s.host && s.host.state === 'up';
  const list = el(
    'ul',
    { class: 'checks' },
    check(s.helper ? 'ok' : 'warn', 'Zalo call module', s.helper ? 'enabled' : 'waiting for login / Zalo to load'),
    check(s.controller ? 'ok' : 'warn', 'Call buttons', s.controller ? 'enabled' : 'open a conversation'),
    check(
      hostOk ? 'ok' : s.host && s.host.state === 'down' ? 'bad' : 'warn',
      'Call helper',
      hostOk ? `connected, Zalo engine ${s.host.zaloVersion || '?'}` : (s.host && s.host.error) || 'not connected yet',
    ),
    check(s.engine && s.engine.running ? 'ok' : '', 'Call engine', s.engine && s.engine.running ? (s.engine.ready ? 'running' : 'starting') : 'idle (starts when you call or are called)'),
  );
  main.append(list);

  if (s.host && s.host.state === 'down') {
    main.append(
      el(
        'div',
        { class: 'hint' },
        'Install the helper once: open the extension folder, run ',
        el('code', {}, 'native\\setup.cmd'),
        ', then reload Zalo Web. Details are in README.md.',
      ),
    );
  }
  if (Array.isArray(s.log) && s.log.length) {
    const d = el('details', {}, el('summary', {}, 'Recent activity'), el('pre', {}, s.log.join('\n')));
    main.append(d);
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab || !/^https:\/\/chat\.zalo\.me\//.test(tab.url || '')) {
    render(null);
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'zwc-status' }, (resp) => {
    if (chrome.runtime.lastError) {
      render({ notLoaded: true });
      return;
    }
    render(resp);
  });
});
