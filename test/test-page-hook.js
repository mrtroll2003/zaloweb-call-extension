'use strict';
// Checks the page hook against the live chat.zalo.me code in a headless Edge
// with a throwaway profile (no Zalo login involved):
//   node test/test-page-hook.js <scratch profile dir> [--extension]
// Without --extension the hook is injected through DevTools at document start
// (same timing as a MAIN-world content script). With --extension, Edge loads
// the unpacked extension instead.
// After the login page loads, it loads Zalo's lazily loaded app chunks and
// requires the call modules, as Zalo would after login, then checks that
// every patch point was found and applied.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Edge's install folder differs between PCs; EDGE_PATH overrides the search.
const EDGE =
  process.env.EDGE_PATH ||
  [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('Microsoft Edge not found. Set EDGE_PATH to the full path of msedge.exe.');
  process.exit(1);
}
const profile = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '.scratch', 'edge-profile'),
);
const useExtension = process.argv.includes('--extension');
const extDir = path.join(__dirname, '..', 'extension');
const hookSrc = fs.readFileSync(path.join(extDir, 'content', 'page-hook.js'), 'utf8');
const PORT = 9333 + Math.floor(Math.random() * 500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  ok - ${label}`);
  } else {
    failed++;
    console.log(`  NOT OK - ${label}${extra ? `\n      ${extra}` : ''}`);
  }
}

async function main() {
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1280,860',
  ];
  if (useExtension) args.push(`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`);
  args.push('about:blank');
  const edge = spawn(EDGE, args, { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 40 && !targets; i++) {
      await sleep(250);
      try {
        targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      } catch (e) {
        /* not up yet */
      }
    }
    if (!targets) throw new Error('Edge did not start');
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    let id = 0;
    const pending = new Map();
    const events = [];
    const logs = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (m.method) {
        events.push(m);
        if (m.method === 'Runtime.consoleAPICalled') {
          const text = m.params.args.map((a) => a.value !== undefined ? a.value : a.description || a.type).join(' ');
          logs.push(`[${m.params.type}] ${text}`);
        } else if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          logs.push(`[exception] ${(d.exception && d.exception.description) || d.text}`.slice(0, 400));
        }
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        const d = r.result.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text);
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    // Logged out, chat.zalo.me sends the browser to the Zalo ID login site. Answer
    // that navigation with "204 No Content" so the tab stays on chat.zalo.me.
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Fetch.requestPaused') {
        send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 204, responseHeaders: [], body: '' });
      }
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*://id.zalo.me/*', resourceType: 'Document', requestStage: 'Request' }] });
    if (!useExtension) await send('Page.addScriptToEvaluateOnNewDocument', { source: hookSrc });
    await send('Page.navigate', { url: 'https://chat.zalo.me/' });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (events.some((e) => e.method === 'Page.loadEventFired')) break;
    }
    // Let Zalo Web finish booting on its own (its startup chunk defines the $z* stubs).
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const booted = await evaluate(`typeof (window.$zcall && window.$zcall.sendDataToNative) === 'function'`).catch(() => false);
      if (booted) break;
    }
    await sleep(3000);
    const navCount = () => events.filter((e) => e.method === 'Page.frameNavigated' && !e.params.frame.parentId).length;
    const navBefore = navCount();

    console.log(`Page hook on live chat.zalo.me (${useExtension ? 'loaded as extension' : 'injected via DevTools'}):`);
    const base = await evaluate(`({
      hook: !!window.__zaloWebCall,
      req: !!(window.__zaloWebCall && window.__zaloWebCall.req),
      modules: window.__zaloWebCall && window.__zaloWebCall.req ? Object.keys(window.__zaloWebCall.req.m).length : 0,
      zcallStub: typeof (window.$zcall && window.$zcall.sendDataToNative),
      title: document.title,
      href: location.href,
      scripts: Array.from(document.scripts).map(s => (s.src || 'inline').split('/').pop()).slice(0, 20),
      reqType: window.__zaloWebCall ? typeof window.__zaloWebCall.req : 'no hook',
      appVisible: !!document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none',
      qr: !!document.querySelector('canvas, img[src*="qr"], .qrcode, [class*="qr"]'),
    })`);
    if (!base.req) console.log('    base:', JSON.stringify(base));
    check(base.hook, 'hook loaded before Zalo scripts');
    check(base.req, `captured webpack require (${base.modules} modules registered)`);
    check(base.title && base.appVisible, `login page rendered normally (title "${base.title}")`);
    check(base.zcallStub === 'function', 'Zalo Web defined its $zcall stub');

    // Load the app chunks Zalo loads after login, then run the call modules.
    const loaded = await evaluate(`(async () => {
      const req = window.__zaloWebCall.req;
      for (const c of [1, 2]) { try { await req.e(c); } catch (e) { return 'chunk ' + c + ' failed: ' + e.message; } }
      return 'ok';
    })()`);
    check(loaded === 'ok', 'lazy app chunks loaded through the hooked loader', loaded);
    await sleep(500);
    check(navCount() === navBefore, 'page did not navigate while loading the app chunks', `navigations: ${navCount() - navBefore}`);

    const found = await evaluate(`(() => {
      const S = window.__zaloWebCall, req = S.req;
      const ids = S.log.map(l => (l.match(/found (call helper|chat box controller) module (\\S+)/) || [])).filter(m => m[2]);
      const out = { ids: ids.map(m => m[1] + '=' + m[2]) };
      for (const m of ids) { try { out[m[1]] = typeof req(m[2]); } catch (e) { out[m[1]] = 'error: ' + e.message; } }
      // the chat header module (pulls in the call config, toast, modal modules ...)
      const header = Object.keys(req.m).find(k => { try { return Function.prototype.toString.call(req.m[k]).includes('csc.header.videocall'); } catch (e) { return false; } });
      out.header = header;
      try { if (header) req(header); out.headerOk = true; } catch (e) { out.headerOk = 'error: ' + e.message; }
      return out;
    })()`);
    check(found.ids.length === 2, `both call modules recognised (${found.ids.join(', ')})`);
    check(found['call helper'] === 'object', 'call helper module ran with the patched require', found['call helper']);
    check(found['chat box controller'] === 'object', 'chat box controller module ran', found['chat box controller']);
    check(found.headerOk === true, `chat header module ran (${found.header})`, String(found.headerOk));
    await sleep(2500); // let the patch loop pick up late modules
    const rt = await evaluate(`({ t: typeof window.__zaloWebCall.req, s: String(window.__zaloWebCall.req).slice(0, 160), keys: window.__zaloWebCall.req && typeof window.__zaloWebCall.req === 'object' ? Object.keys(window.__zaloWebCall.req).slice(0, 12) : null })`);
    if (rt.t !== 'function') console.log('    S.req is now:', JSON.stringify(rt));

    const st = await evaluate(`(() => {
      const S = window.__zaloWebCall, h = S.helper;
      const helperMod = S.log.map(l => (l.match(/found call helper module (\\S+)/) || [])[1]).find(Boolean);
      const flags = Object.values(S.req(helperMod)).filter(v => typeof v === 'boolean');
      return {
        helper: !!h,
        isSupport: h && h.isSupport(), video: h && h.isSupportVideoCall(), ipc: h && h.canUseIpcCall(),
        flipped: flags,
        zcall: /toHost/.test(String(window.$zcall.sendDataToNative)) && /toHost/.test(String(window.$zcall.initCall)) && typeof window.$zcall.onCallResponseDevices === 'function',
        zsubSame: !!window.$zsub && /toHost/.test(String(window.$zsub.$zcall && window.$zsub.$zcall.sendDataToNative)),
        diag: S.diag(),
        log: S.log,
      };
    })()`);
    check(st.helper && st.isSupport && st.video && st.ipc, 'call helper switched on (isSupport / video / IPC)');
    check(st.flipped.length === 1 && st.flipped[0] === true, `PC-only flag export flipped to true (${JSON.stringify(st.flipped)})`);
    check(st.zcall && st.zsubSame, '$zcall and $zsub.$zcall now lead to the extension bridge');
    check(st.diag.controller, 'chat box controller makeCall replaced');
    for (const [k, v] of Object.entries(st.diag.found)) check(v, `found Zalo module: ${k}`);
    check(st.diag.patched.header, 'chat header patched to show the video call button');
    const hdr = await evaluate(`(() => {
      const C = window.__zaloWebCall.headerConfigClass;
      if (!C) return 'no class';
      const c = new C('call', { visibility: { group_member_threshold: 20, community_member_threshold: -1, web_enabled: 0 } }, {});
      const v = c.key('visibility');
      const other = new C('reminder', { visibility: { web_enabled: 0 } }, {});
      return { web: v.object.web_enabled, thr: v.object.group_member_threshold, otherKeyUntouched: other.key('visibility').object.web_enabled === 0 };
    })()`);
    check(hdr && hdr.web === 1 && hdr.thr === 20 && hdr.otherKeyUntouched, 'header call config reports web_enabled = 1 (other configs untouched)', JSON.stringify(hdr));
    check(st.diag.patched.modal, '"use Zalo PC" dialog redirected');
    check(st.diag.patched.actions, 'call actions (makeCall / makeVoiceCall / makeVideoCall) redirected');

    const flow = await evaluate(`(async () => {
      const S = window.__zaloWebCall, h = S.helper;
      const out = {};
      // init data builds without Electron/Node APIs
      try { const d = await h.getInitialData('123'); out.init = d && d.local && d.local.id === '123' && 'clientVersion' in d; } catch (e) { out.init = 'error: ' + e.message; }
      // capture what the page would send to the helper
      const sent = [];
      const listener = (e) => sent.push(JSON.parse(e.detail));
      document.addEventListener('zalo-web-call:to-ext', listener);
      h.endCall();
      await new Promise(r => setTimeout(r, 50));
      document.removeEventListener('zalo-web-call:to-ext', listener);
      out.endCall = sent.find(m => m.kind === 'host' && m.msg.op === 'send' && m.msg.msg.command === 'endCall') ? true : JSON.stringify(sent).slice(0, 300);
      // a message from the engine is dispatched to the helper
      document.dispatchEvent(new CustomEvent('zalo-web-call:to-page', { detail: JSON.stringify({ kind: 'host', msg: { op: 'native', msg: { type: 'update', command: 'callState', data: { state: 'calling' } } } }) }));
      out.calling = h.isCalling();
      document.dispatchEvent(new CustomEvent('zalo-web-call:to-page', { detail: JSON.stringify({ kind: 'host', msg: { op: 'native', msg: { type: 'update', command: 'callState', data: { state: 'free' } } } }) }));
      out.free = !h.isCalling();
      // a listDevice response reaches the waiting listener
      let got = null;
      window.$zcall.onCallResponseDevices((ev, data) => { got = data; });
      document.dispatchEvent(new CustomEvent('zalo-web-call:to-page', { detail: JSON.stringify({ kind: 'host', msg: { op: 'native', msg: { type: 'response', command: 'listDevice', data: { x: 1 } } } }) }));
      out.response = !!got && got.x === 1;
      return out;
    })()`);
    check(flow.init === true, 'init data is built in the browser', String(flow.init));
    check(flow.endCall === true, 'helper requests go out through the bridge', String(flow.endCall));
    check(flow.calling === true && flow.free === true, 'engine call-state updates reach Zalo\'s call helper');
    check(flow.response === true, 'engine responses reach waiting listeners');

    if (useExtension) {
      const rt = await evaluate(`new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), 8000);
        document.addEventListener('zalo-web-call:to-page', function on(e) {
          const m = JSON.parse(e.detail);
          if (m.kind === 'host' || m.kind === 'host-down') { clearTimeout(t); document.removeEventListener('zalo-web-call:to-page', on); resolve(m); }
        });
        document.dispatchEvent(new CustomEvent('zalo-web-call:to-ext', { detail: JSON.stringify({ kind: 'host', msg: { op: 'hello' } }) }));
      })`);
      check(!rt.timeout, 'page -> content script -> service worker -> native host round trip answers', JSON.stringify(rt));
      console.log('    helper answer:', JSON.stringify(rt));
      if (process.argv.includes('--nm-chain') && process.env.ZWC_NM_PROBE) {
        const probe = process.env.ZWC_NM_PROBE;
        const r1 = await evaluate(`(async () => { ${probe}; return await ask({ op: 'hello' }, (m) => (m.kind === 'host' && m.msg.op === 'hello') || m.kind === 'host-down'); })()`);
        check(r1.kind === 'host' && r1.msg.ok === true, 'Edge started the registered helper through the .cmd launcher', JSON.stringify(r1));
        const r2 = await evaluate(`(async () => { ${probe}; return await ask({ op: 'send', msg: { type: 'request', command: 'makeCall', data: { partner: [{ id: '777', name: 'x' }], type: 1 } } }, (m) => m.kind === 'host' && m.msg.op === 'native' && m.msg.msg.type === 'sendSignal'); })()`);
        check(r2.kind === 'host' && r2.msg.msg.command === 401, 'call request reached the engine and its first signal came back to the page', JSON.stringify(r2).slice(0, 300));
        const r3 = await evaluate(`(async () => { ${probe}; return await ask({ op: 'hello' }, (m) => m.kind === 'host' && m.msg.op === 'hello'); })()`);
        check(r3.msg && r3.msg.engineRunning === true && r3.msg.engineReady === true, 'helper reports the engine running and ready', JSON.stringify(r3));
      }
    }
    const ownErrors = logs.filter((l) => /\[exception\]/.test(l) && /page-hook|zwc|__zaloWebCall/.test(l));
    check(ownErrors.length === 0, 'no exceptions thrown from the hook', ownErrors.join('\n      '));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) {
      console.log('\nHook log:\n  ' + st.log.join('\n  '));
      console.log('\nConsole (last 25):\n  ' + logs.slice(-25).join('\n  '));
    }
    ws.close();
  } finally {
    edge.kill();
    await sleep(1500);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (e) {
      /* Edge may still hold a file for a moment; harmless */
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('test error:', e);
  process.exitCode = 1;
});
