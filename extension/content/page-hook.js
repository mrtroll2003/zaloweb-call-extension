/*
 * Zalo Web Call - page hook (runs in chat.zalo.me's own JavaScript world at
 * document_start, before any Zalo script).
 *
 * Zalo Web is built from the same code as Zalo PC. Its call module (the
 * "zcall-v2" call helper) is shipped to the browser, but switched off: it
 * reports "not supported" and its bridge to the native call engine
 * ($zcall.sendDataToNative) is an empty stub. On Zalo PC that bridge leads,
 * through Electron, to ZaloCall.exe, which does the audio/video and shows the
 * call window.
 *
 * This script:
 *   1. hooks webpack's chunk loading so it can patch two modules as they load:
 *      the call helper (turned on, wired to our bridge) and the chat box
 *      controller (its makeCall stub replaced by the Zalo PC logic);
 *   2. makes $zcall talk to the extension, which relays to the local helper
 *      (native messaging host) that runs ZaloCall.exe;
 *   3. lets Zalo's own header show the voice/video call buttons, and routes
 *      the other "call" entry points (call-back on call bubbles, etc.).
 * Signalling (request/answer/end/...) is done by Zalo Web's own code over its
 * normal authenticated API, exactly as Zalo PC does it.
 */
(() => {
  'use strict';
  if (window.__zaloWebCall) return;

  const VERSION = '0.1.0';
  const TAG = '[Zalo Web Call]';
  const EVT_TO_EXT = 'zalo-web-call:to-ext';
  const EVT_TO_PAGE = 'zalo-web-call:to-page';
  const SIG_HELPER = '[zcall-v2] call-helper:';
  const SIG_CHATBOX = '[zcall-v2] Call is not supported!';
  const SIG_HEADER = 'csc.header.videocall'; // chat header (call buttons)
  const GROUP_PREFIX = 'g';
  const CALL_TYPE_AUDIO = 0; // Zalo's CallType enum: AUDIO=0, VIDEO=1

  // Zalo later rewires console methods to its own logger; keep the originals.
  const out = {
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const info = (...a) => out.info(TAG, ...a);
  const warn = (...a) => out.warn(TAG, ...a);
  const fnSrc = (f) => {
    try {
      return Function.prototype.toString.call(f);
    } catch (e) {
      return '';
    }
  };

  const S = {
    version: VERSION,
    req: null, // webpack's __webpack_require__
    helper: null, // Zalo's call helper singleton
    errors: null, // its error-string table (IN_CALL, ...)
    controllerPatched: false,
    lastController: null,
    listenersStarted: false,
    uid: null,
    host: { state: 'unknown', error: null, hello: null }, // unknown | up | down
    engine: { running: false, ready: false },
    bridgeDown: false,
    patched: { header: false, modal: false, actions: false },
    log: [],
  };
  Object.defineProperty(window, '__zaloWebCall', { value: S });

  function note(msg) {
    S.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (S.log.length > 60) S.log.shift();
    info(msg);
    pushStatus();
  }

  // ---------------------------------------------------------------------------
  // 1. webpack hook
  // ---------------------------------------------------------------------------
  const patchedChunks = new WeakSet();

  function patchChunk(data) {
    if (!Array.isArray(data) || !data[1] || typeof data[1] !== 'object' || patchedChunks.has(data)) return;
    patchedChunks.add(data);
    const modules = data[1];
    for (const id of Object.keys(modules)) {
      const f = modules[id];
      if (typeof f !== 'function') continue;
      const src = fnSrc(f);
      if (src.includes(SIG_HELPER)) {
        modules[id] = wrapFactory(f, flipFalseExports, (module) => onHelperModule(module.exports));
        note(`found call helper module ${id}`);
      } else if (src.includes(SIG_CHATBOX)) {
        modules[id] = wrapFactory(f, null, (module) => onChatBoxModule(module.exports));
        note(`found chat box controller module ${id}`);
      } else if (src.includes(SIG_HEADER) && src.includes('isWebCallEnabled')) {
        modules[id] = wrapFactory(f, forceHeaderVideoButton, () => {
          S.patched.header = true;
          note('chat header patched (video call button)');
        });
        note(`found chat header module ${id}`);
      }
    }
  }

  // The header shows its video-call button in Zalo Web only when the remote
  // config "call" -> visibility.web_enabled >= 1 (otherwise it is hidden). That
  // config object is private to the header module, so give that module (only)
  // a remote-config class that reports web_enabled = 1 for the "call" key.
  function forceHeaderVideoButton(req) {
    const proxies = new WeakMap();
    const r2 = function (id) {
      const ex = req(id);
      if (!ex || (typeof ex !== 'object' && typeof ex !== 'function')) return ex;
      let Base;
      try {
        Base = ex.AdvancedRemoteConfigs;
      } catch (e) {
        return ex;
      }
      if (typeof Base !== 'function') return ex;
      if (!proxies.has(ex)) {
        class CallRemoteConfigs extends Base {
          key(name) {
            const k = super.key(name);
            if (this.remoteKey !== 'call' || name !== 'visibility' || !k) return k;
            const merged = Object.assign({}, k.object);
            if (!(Number(merged.web_enabled) >= 1)) merged.web_enabled = 1;
            return Object.create(k, { object: { get: () => merged } });
          }
        }
        S.headerConfigClass = CallRemoteConfigs; // for diagnostics
        proxies.set(
          ex,
          new Proxy(ex, { get: (t, p, r) => (p === 'AdvancedRemoteConfigs' ? CallRemoteConfigs : Reflect.get(t, p, r)) }),
        );
      }
      return proxies.get(ex);
    };
    for (const k of Object.keys(req)) r2[k] = req[k];
    return r2;
  }

  function wrapFactory(orig, transformReq, after) {
    return function zwcWrappedFactory(module, exports, req) {
      const result = orig.call(this, module, exports, transformReq ? transformReq(req) : req);
      try {
        after(module);
      } catch (e) {
        warn('patch failed', e);
      }
      return result;
    };
  }

  // The call helper module exports a boolean "is this the PC app" flag (false in
  // the web build). Zalo Web only starts the call listeners when it is true.
  function flipFalseExports(req) {
    const r2 = function (id) {
      return req(id);
    };
    for (const k of Object.keys(req)) r2[k] = req[k];
    r2.d = function (exp, name, getter) {
      return req.d(exp, name, function () {
        const v = getter();
        return v === false ? true : v;
      });
    };
    return r2;
  }

  function installWebpackHook() {
    const arr = Array.isArray(window.webpackJsonp) ? window.webpackJsonp : [];
    arr.forEach(patchChunk);
    const rawPush = function (...items) {
      return Array.prototype.push.apply(arr, items);
    };
    let current = rawPush;
    // Each read returns a wrapper bound to the handler current at read time, so
    // a runtime that binds the old push as its parent never loops back to itself.
    Object.defineProperty(arr, 'push', {
      configurable: true,
      enumerable: false,
      get() {
        const target = current;
        return function zwcPush(...items) {
          for (const it of items) {
            try {
              patchChunk(it);
            } catch (e) {
              warn('chunk patch failed', e);
            }
          }
          return target.apply(arr, items);
        };
      },
      set(fn) {
        current = fn;
      },
    });
    window.webpackJsonp = arr;
    // A one-module chunk whose module runs at once and hands us __webpack_require__.
    arr.push([
      ['zwc-capture'],
      {
        'zwc-capture': function (module, exports, req) {
          S.req = req;
        },
      },
      [['zwc-capture']],
    ]);
  }

  // ---------------------------------------------------------------------------
  // 2. finding Zalo's internal modules by shape (minified names change per build)
  // ---------------------------------------------------------------------------
  function scanModules(pick) {
    const cache = S.req && S.req.c;
    if (!cache) return null;
    for (const id in cache) {
      const mod = cache[id];
      if (!mod || !mod.l) continue;
      const ex = mod.exports;
      if (!ex || (typeof ex !== 'object' && typeof ex !== 'function')) continue;
      try {
        const r = pick(ex);
        if (r) return r;
      } catch (e) {
        /* module still initialising */
      }
    }
    return null;
  }

  const valuesOf = (ex) =>
    Object.keys(ex).map((k) => {
      try {
        return ex[k];
      } catch (e) {
        return undefined;
      }
    });
  const byDefault = (test) => (ex) => (ex.default && test(ex.default) ? ex.default : null);

  const FINDERS = {
    user: byDefault((d) => typeof d.getUidMe === 'function' && typeof d.getMiniInfo === 'function'),
    config: byDefault((d) => typeof d.apiVersion === 'number' && 'enableCall' in d && d.call && typeof d.call === 'object'),
    i18n: byDefault((d) => typeof d.str === 'function' && typeof d.getCurrentLanguageName === 'function'),
    toast: byDefault((d) => typeof d.createError === 'function' && typeof d.createInfo === 'function'),
    chatRegistry: byDefault((d) => typeof d.getChatBoxControllerByConvId === 'function'),
    modalManager: (ex) => (ex.ModalManagerV2 && typeof ex.ModalManagerV2.openModal === 'function' ? ex.ModalManagerV2 : null),
    modalIds: (ex) => (ex.ModalIdentitiesDefine && ex.ModalIdentitiesDefine.VIDEO_CALL_SUGGEST ? ex.ModalIdentitiesDefine : null),
    container: (ex) => (ex.ModuleContainer && typeof ex.ModuleContainer.resolve === 'function' ? ex.ModuleContainer : null),
    sidebar: (ex) => (ex.SidebarController != null ? ex.SidebarController : null),
    actions: (ex) => {
      const vals = valuesOf(ex);
      if (!vals.some((v) => v && typeof v === 'object' && v.MakeVoiceCall === 'makeVoiceCall')) return null;
      for (const v of vals) {
        // getActions is a tiny zero-argument arrow function: () => dispatchers
        if (typeof v === 'function' && v.length === 0 && fnSrc(v).length < 40) {
          const r = v();
          if (r && typeof r === 'object' && typeof r.makeVoiceCall === 'function') return r;
        }
      }
      return null;
    },
  };
  // Diagnostics (DevTools console): __zaloWebCall.diag()
  S.diag = () => {
    const found = {};
    for (const k of Object.keys(FINDERS)) found[k] = !!need(k);
    return { helper: !!S.helper, controller: S.controllerPatched, listeners: S.listenersStarted, patched: { ...S.patched }, host: { ...S.host, hello: undefined }, engine: { ...S.engine }, found };
  };

  const M = {};
  const missAt = {}; // finder -> module count at the last unsuccessful scan
  function moduleCount() {
    return S.req && S.req.c ? Object.keys(S.req.c).length : 0;
  }
  function need(name) {
    if (M[name]) return M[name];
    const count = moduleCount();
    if (missAt[name] === count) return null; // nothing new has loaded since the last miss
    const v = scanModules(FINDERS[name]);
    if (v) M[name] = v;
    else missAt[name] = count;
    return v || null;
  }

  // ---------------------------------------------------------------------------
  // 3. bridge to the extension (content script -> service worker -> helper)
  // ---------------------------------------------------------------------------
  function toExt(payload) {
    document.dispatchEvent(new CustomEvent(EVT_TO_EXT, { detail: JSON.stringify(payload) }));
  }
  function toHost(msg) {
    if (S.bridgeDown) return;
    let clean;
    try {
      clean = JSON.parse(JSON.stringify(msg));
    } catch (e) {
      warn('cannot serialise message for helper', e);
      return;
    }
    toExt({ kind: 'host', msg: clean });
  }

  let helloWaiters = [];
  function hostHello(timeoutMs = 2500) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        helloWaiters = helloWaiters.filter((w) => w !== done);
        resolve(S.host.state === 'up');
      }, timeoutMs);
      const done = (ok) => {
        clearTimeout(t);
        resolve(ok);
      };
      helloWaiters.push(done);
      toHost({ op: 'hello' });
    });
  }

  document.addEventListener(EVT_TO_PAGE, (e) => {
    let m;
    try {
      m = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    onExtMessage(m);
  });

  function onExtMessage(m) {
    switch (m && m.kind) {
      case 'host':
        onHostMessage(m.msg || {});
        break;
      case 'host-down':
        S.host = { state: 'down', error: m.error || 'helper not available', hello: null };
        S.engine = { running: false, ready: false };
        note(`helper unavailable: ${S.host.error}`);
        helloWaiters.splice(0).forEach((w) => w(false));
        if (S.helper) safe(() => S.helper.handleUpdate(null, 'callState', { state: 'free' }));
        break;
      case 'bridge-reset':
        // The extension's service worker restarted. Reconnect; the hello reply
        // resends the init data (see onHostMessage).
        S.host = { state: 'unknown', error: null, hello: null };
        setTimeout(() => {
          if (S.listenersStarted) hostHello();
        }, 1000);
        break;
      case 'bridge-down':
        S.bridgeDown = true;
        note('extension was reloaded or removed; reload this tab to use calls again');
        break;
      default:
        break;
    }
  }

  function onHostMessage(msg) {
    switch (msg.op) {
      case 'hello': {
        const wasUp = S.host.state === 'up';
        S.host = msg.ok ? { state: 'up', error: null, hello: msg } : { state: 'down', error: msg.error, hello: msg };
        S.engine = { running: !!msg.engineRunning, ready: !!msg.engineReady };
        note(msg.ok ? `helper ${msg.hostVersion} ready (Zalo engine ${msg.zaloVersion})` : `helper not set up: ${msg.error}`);
        helloWaiters.splice(0).forEach((w) => w(!!msg.ok));
        if (msg.ok && !wasUp && S.listenersStarted) sendInit();
        break;
      }
      case 'engine':
        S.engine = { running: !!msg.running, ready: !!msg.ready };
        pushStatus();
        break;
      case 'native':
        dispatchNative(msg.msg);
        break;
      case 'error':
        note(`helper error: ${msg.error}`);
        break;
      default:
        break;
    }
  }

  // Messages from ZaloCall.exe, routed like Zalo PC's preload does.
  const responseListeners = new Map(); // command -> Set<fn>
  function dispatchNative(msg) {
    const h = S.helper;
    if (!h || !msg) return;
    try {
      switch (msg.type) {
        case 'update':
          h.handleUpdate(null, msg.command, msg.data);
          break;
        case 'sendSignal':
          h.handleSendSignal(null, msg.command, msg.data);
          break;
        case 'request':
          if (msg.command === 'popup') {
            const d = msg.data || {};
            toast(d.content || d.header || 'Zalo call', 'info');
          } else {
            h.handleRequest(null, msg.command, msg.data);
          }
          break;
        case 'response': {
          const set = responseListeners.get(msg.command);
          if (set) {
            const fns = Array.from(set);
            set.clear();
            fns.forEach((fn) => safe(() => fn(null, msg.data)));
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      warn(`failed to handle ${msg.type}:${msg.command}`, e);
    }
  }

  // What Zalo's call helper expects $zcall (and $zsub.$zcall) to provide.
  const ZCALL = {
    sendDataToNative(msg) {
      toHost({ op: 'send', msg });
    },
    initCall(msg) {
      toHost({ op: 'init', msg });
    },
    onCallResponseDevices(fn) {
      if (!responseListeners.has('listDevice')) responseListeners.set('listDevice', new Set());
      responseListeners.get('listDevice').add(fn);
    },
    removeListenCallDevices(fn) {
      const set = responseListeners.get('listDevice');
      if (set) set.delete(fn);
    },
    onCallSignal() {},
    removeListenCallSignal() {},
    onCallRequest() {},
    removeListenCallRequest() {},
    onCallUpdate() {},
    removeListenCallUpdate() {},
  };
  function installZcall() {
    const target = window.$zcall && typeof window.$zcall === 'object' ? window.$zcall : (window.$zcall = {});
    Object.assign(target, ZCALL);
    const sub = window.$zsub;
    if (sub && typeof sub === 'object') {
      if (sub.$zcall && sub.$zcall !== target && typeof sub.$zcall === 'object') Object.assign(sub.$zcall, ZCALL);
      else if (!sub.$zcall) sub.$zcall = target;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. the call helper
  // ---------------------------------------------------------------------------
  function onHelperModule(exports) {
    for (const v of valuesOf(exports)) {
      if (v && typeof v === 'object' && typeof v.handleSendSignal === 'function' && typeof v.makeCall === 'function') S.helper = v;
      else if (v && typeof v === 'object' && typeof v.IN_CALL === 'string') S.errors = v;
    }
    if (!S.helper) {
      note('call helper instance not found; this Zalo Web version is not supported yet');
      return;
    }
    patchHelper(S.helper);
    note('call helper patched');
  }

  function patchHelper(h) {
    h.isSupport = () => true;
    h.isSupportVideoCall = () => true;
    h.canUseIpcCall = () => true;
    h.getInitialData = (uid) => buildInitData(h, uid);
    // Zalo PC uploads compressed engine logs to Zalo's QoS server after calls;
    // the browser has no access to those files, so skip it.
    h.uploadLog = async () => {};
    h.uploadLogGroup = async () => {};
    const origStart = typeof h.startListeners === 'function' ? h.startListeners.bind(h) : null;
    h.startListeners = (uid) => {
      if (S.listenersStarted) return;
      S.listenersStarted = true;
      if (origStart) safe(() => origStart(uid)); // binds incoming-call events
      wirePc(uid);
    };
    installZcall();
    startPatchLoop();
  }

  async function buildInitData(h, uidArg) {
    const user = need('user');
    const cfg = need('config') || {};
    const i18n = need('i18n');
    const uid = uidArg || (user && safe(() => user.getUidMe())) || S.uid || '';
    const mini = (user && uid && safe(() => user.getMiniInfo(uid))) || {};
    const devices = safe(() => h._getDefaultDevices()) || {};
    const advanced = safe(() => h.getAdvancedSettings(uid)) || {};
    return Object.assign(
      {
        local: { id: uid, avatar: mini.avatar, name: mini.dName },
        osInfo: '', // filled in by the helper
        mainWindowId: uid,
        logPath: '',
        zrtcLogPath: '',
        dumpPath: '',
        clientVersion: cfg.apiVersion,
        language: (i18n && safe(() => i18n.getCurrentLanguageName())) || 'vi',
        timeoutMakeCall2ZRtp: cfg.timeoutMakeCall2ZRtp,
        enablePreviewDeviceOutgoing: cfg.enable_preview_device_outgoing,
        enablePreviewDeviceIncall: cfg.enable_preview_device_incall,
        enableUnstableConnecting: cfg.enable_unstable_connecting,
      },
      devices,
      advanced,
    );
  }

  // What Zalo PC's startListeners adds on top of the web version.
  function wirePc(uid) {
    S.uid = uid || (need('user') && safe(() => need('user').getUidMe())) || null;
    note(`call listeners started for user ${S.uid ? 'ok' : '(unknown yet)'}`);
    installZcall();
    // The first hello reply sends the init data; if the helper is already up, send now.
    if (S.host.state === 'up') sendInit();
    else hostHello();
    // Zalo PC re-sends "updateLocal" once the profile has loaded.
    setTimeout(() => {
      if (S.helper && S.host.state === 'up') safe(() => S.helper.sendInitData(S.uid, 'updateLocal', true));
    }, 8000);
  }

  function sendInit() {
    const h = S.helper;
    if (!h || !S.listenersStarted) return;
    const cfg = need('config') || {};
    const startNative = !!(cfg.call && cfg.call.launch_native_in_startup); // the helper may still start lazily
    Promise.resolve()
      .then(() => h.sendInitData(S.uid))
      .then(() => h.sendInitData(S.uid, 'init', true, { shouldStartNative: startNative }))
      .catch((e) => warn('sending init data failed', e));
  }

  // Fallback if Zalo never calls startListeners (e.g. the flag trick stops working).
  function maybeStartListeners() {
    if (S.listenersStarted || !S.helper) return;
    const user = need('user');
    const uid = user && safe(() => user.getUidMe());
    if (uid) S.helper.startListeners(uid);
  }

  // ---------------------------------------------------------------------------
  // 5. placing calls
  // ---------------------------------------------------------------------------
  function onChatBoxModule(exports) {
    const Cls = valuesOf(exports).find(
      (v) => typeof v === 'function' && v.prototype && typeof v.prototype._getFullInfoConversation === 'function',
    );
    if (!Cls) {
      note('chat box controller class not found');
      return;
    }
    const perInstance = new WeakMap();
    // The constructor does `this.makeCall = <"not supported" stub>`. An accessor on
    // the prototype swallows that assignment and serves the real implementation.
    Object.defineProperty(Cls.prototype, 'makeCall', {
      configurable: true,
      get() {
        S.lastController = this;
        let fn = perInstance.get(this);
        if (!fn) {
          const ctrl = this;
          fn = (isVideo = true, conv = null) => callFromController(ctrl, isVideo, conv);
          perInstance.set(this, fn);
        }
        return fn;
      },
      set() {},
    });
    S.controllerPatched = true;
    note('chat box controller patched');
  }

  async function ensureReady() {
    if (S.bridgeDown) {
      toast(t('reload'), 'error');
      return false;
    }
    if (!S.helper) {
      toast(t('notReady'), 'error');
      return false;
    }
    if (S.host.state !== 'up') {
      const ok = await hostHello();
      if (!ok) {
        toast(S.host.hello && S.host.hello.error ? `${t('helperError')} ${S.host.hello.error}` : t('noHelper'), 'error');
        return false;
      }
    }
    if (!S.listenersStarted) maybeStartListeners();
    return true;
  }

  async function callFromController(ctrl, isVideo, convOverride) {
    if (!(await ensureReady())) return;
    let conv = convOverride;
    if (!conv) conv = await Promise.resolve(safe(() => ctrl._getFullInfoConversation())).catch(() => null);
    if (!conv || !conv.userId) conv = Object.assign({}, conv || {}, { userId: ctrl.convId });
    placeCall(conv, !!isVideo, ctrl);
  }

  function placeCall(conv, isVideo, ctrl) {
    const h = S.helper;
    if (safe(() => h.isCalling())) {
      toast(str((S.errors && S.errors.IN_CALL) || 'STR_CALL_IN_ANOTHER_CALL'), 'info');
      return;
    }
    const user = need('user');
    const me = user && safe(() => user.getUidMe());
    const id = conv && conv.userId != null ? String(conv.userId) : '';
    if (!id || !me) return;
    if (id.startsWith(GROUP_PREFIX)) {
      openGroupCall(conv, isVideo, ctrl);
      return;
    }
    note(`placing ${isVideo ? 'video' : 'voice'} call`);
    try {
      h.makeCall(
        [id],
        isVideo,
        false,
        (callInfo) => {
          if (ctrl && typeof ctrl.generateReceiveCallMessage === 'function') safe(() => ctrl.generateReceiveCallMessage(callInfo));
        },
        conv,
      );
    } catch (e) {
      warn('makeCall failed', e);
      toast(str('STR_TOAST_FAILED_CALLING'), 'error');
    }
  }

  function openGroupCall(conv, isVideo, ctrl) {
    const cfg = need('config') || {};
    const MM = need('modalManager');
    const IDS = need('modalIds');
    if (!cfg.enable_group_call_for_user) {
      toast(t('groupOff'), 'info');
      return;
    }
    if (!MM || !IDS || !IDS.GROUP_CALL) {
      toast(t('groupUnavailable'), 'info');
      return;
    }
    MM.openModal({
      windowId: (ctrl && ctrl.windowId) || '1',
      name: IDS.GROUP_CALL,
      params: {
        conversation: conv,
        data: {
          isVideo,
          generateCallMessage: ctrl && ctrl._generateCallMessage ? ctrl._generateCallMessage.bind(ctrl) : () => {},
          maxUsers: cfg.group_call_max_users,
        },
      },
    });
  }

  function currentConvId() {
    const C = need('container');
    const SB = need('sidebar');
    const id = C && SB ? safe(() => C.resolve(SB).getCurrMainConvId()) : null;
    return id || (S.lastController && S.lastController.convId) || null;
  }
  function controllerFor(convId) {
    const reg = need('chatRegistry');
    return (reg && convId && safe(() => reg.getChatBoxControllerByConvId(convId))) || null;
  }
  function callConversation(convId, isVideo) {
    if (!convId) return;
    const ctrl = controllerFor(convId);
    if (ctrl) ctrl.makeCall(isVideo, null);
    else ensureReady().then((ok) => ok && placeCall({ userId: convId }, isVideo, null));
  }

  // Zalo Web opens a "use Zalo PC to call" dialog from several places. Turn
  // those into calls on the open conversation.
  function onCallSuggestion() {
    const ev = window.event;
    const target = ev && ev.target instanceof Element ? ev.target : null;
    let isVideo = false;
    if (target && target.closest('#headerBtns')) {
      isVideo = true; // the header's video-call button
    } else if (target) {
      // e.g. "Gọi lại" on a call bubble: repeat the same kind of call
      let el = target;
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
        const text = el.textContent || '';
        if (text.length > 400) break;
        if (/video/i.test(text)) {
          isVideo = true;
          break;
        }
      }
    }
    const convId = currentConvId();
    if (!convId) {
      toast(t('openChat'), 'info');
      return;
    }
    callConversation(convId, isVideo);
  }

  // Patches that need modules which load later than the call helper.
  function tryLatePatches() {
    if (!S.patched.modal) {
      const MM = need('modalManager');
      const IDS = need('modalIds');
      if (MM && IDS) {
        const orig = MM.openModal;
        MM.openModal = function (opts) {
          if (opts && opts.name === IDS.VIDEO_CALL_SUGGEST) {
            safe(onCallSuggestion);
            return undefined;
          }
          return orig.apply(this, arguments);
        };
        S.patched.modal = true;
        note('call suggestion dialog redirected');
      }
    }
    if (!S.patched.actions) {
      const actions = need('actions');
      if (actions) {
        const defs = {
          makeCall: (x) => x && callConversation(x.chatID, x.callType !== CALL_TYPE_AUDIO),
          makeVoiceCall: (x) => x && callConversation(x.chatID, false),
          makeVideoCall: (x) => x && callConversation(x.chatID, true),
        };
        for (const [k, fn] of Object.entries(defs)) {
          Object.defineProperty(actions, k, { configurable: true, enumerable: true, get: () => fn, set() {} });
        }
        S.patched.actions = true;
        note('call actions redirected');
      }
    }
    return S.patched.modal && S.patched.actions;
  }

  let loopTimer = null;
  function startPatchLoop() {
    if (loopTimer) return;
    let n = 0;
    loopTimer = setInterval(() => {
      n++;
      installZcall();
      const lateDone = tryLatePatches();
      if (!S.listenersStarted && n >= 20) maybeStartListeners(); // ~20 s after the helper loaded
      if (lateDone && S.listenersStarted && n > 30) {
        clearInterval(loopTimer);
        loopTimer = null;
      }
      if (n > 600) {
        clearInterval(loopTimer); // give up after 10 minutes
        loopTimer = null;
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // 6. small UI helpers
  // ---------------------------------------------------------------------------
  const TEXT = {
    vi: {
      noHelper: 'Zalo Web Call: chưa cài trình trợ giúp gọi điện. Mở thư mục tiện ích, chạy native\\setup.cmd rồi tải lại trang.',
      helperError: 'Zalo Web Call: trình trợ giúp báo lỗi:',
      notReady: 'Zalo Web Call: chức năng gọi chưa sẵn sàng. Hãy đợi Zalo tải xong rồi thử lại.',
      reload: 'Zalo Web Call vừa được cập nhật. Hãy tải lại trang để gọi điện.',
      openChat: 'Hãy mở một cuộc trò chuyện để gọi.',
      groupOff: 'Zalo chưa bật gọi nhóm cho tài khoản này trên web. Hiện chỉ gọi được 1-1.',
      groupUnavailable: 'Gọi nhóm chưa dùng được trên Zalo Web. Hiện chỉ gọi được 1-1.',
    },
    en: {
      noHelper: 'Zalo Web Call: the call helper is not installed. In the extension folder run native\\setup.cmd, then reload this page.',
      helperError: 'Zalo Web Call: the call helper reported an error:',
      notReady: 'Zalo Web Call: calling is not ready yet. Wait for Zalo to finish loading and try again.',
      reload: 'Zalo Web Call was updated. Reload this page to make calls.',
      openChat: 'Open a conversation to call.',
      groupOff: 'Zalo has not enabled group calls for this account on the web. Only 1-to-1 calls work for now.',
      groupUnavailable: 'Group calls are not available in Zalo Web yet. Only 1-to-1 calls work for now.',
    },
  };
  function lang() {
    const i18n = need('i18n');
    const l = (i18n && safe(() => i18n.getCurrentLanguageName())) || document.documentElement.lang || 'vi';
    return String(l).toLowerCase().startsWith('vi') ? 'vi' : 'en';
  }
  const t = (k) => TEXT[lang()][k] || TEXT.en[k] || k;
  function str(key) {
    const i18n = need('i18n');
    return (i18n && safe(() => i18n.str(key))) || key;
  }

  function toast(text, kind) {
    const z = need('toast');
    if (z) {
      const fn = kind === 'error' ? z.createError : kind === 'warning' ? z.createWarning : z.createInfo;
      if (typeof fn === 'function' && safe(() => (fn.call(z, text), true))) return;
    }
    const el = document.createElement('div');
    el.textContent = text;
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;max-width:520px;' +
      'padding:10px 16px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;color:#fff;' +
      `background:${kind === 'error' ? '#c62828' : '#263238'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      return undefined;
    }
  }

  let statusTimer = null;
  function pushStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      toExt({
        kind: 'status',
        status: {
          version: VERSION,
          webpack: !!S.req,
          helper: !!S.helper,
          controller: S.controllerPatched,
          listeners: S.listenersStarted,
          patched: S.patched,
          host: { state: S.host.state, error: S.host.error, hostVersion: S.host.hello && S.host.hello.hostVersion, zaloVersion: S.host.hello && S.host.hello.zaloVersion },
          engine: S.engine,
          log: S.log.slice(-15),
        },
      });
    }, 200);
  }

  installWebpackHook();
  note(`v${VERSION} loaded`);
})();
